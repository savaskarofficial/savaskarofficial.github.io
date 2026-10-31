(function () {
  'use strict';

  const USER = 'savaskarofficial';
  const API = 'https://api.github.com/users/' + USER + '/repos';
  const CACHE_KEY = 'savaskarofficial.repositories.v1';
  const BACKOFF_KEY = 'savaskarofficial.repositories.retry.v1';
  const CACHE_MAX_AGE = 10 * 60 * 1000;
  const FEATURED = ['covert', 'osinet', 'metadata_forensic'];
  const PAGE_SIZE = 100;

  class RepositoryError extends Error {
    constructor(message, kind, retryAt = 0) {
      super(message);
      this.name = 'RepositoryError';
      this.kind = kind;
      this.retryAt = retryAt;
    }
  }

  function cleanText(value) {
    return typeof value === 'string' ? value.replace(/\s*[\u2013\u2014]\s*/g, ' - ').trim() : '';
  }

  function validDate(value) {
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function normalizeRepository(raw) {
    if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.id) || raw.id <= 0 ||
        typeof raw.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(raw.name) ||
        raw.name === '.' || raw.name === '..' || raw.private !== false ||
        typeof raw.owner?.login !== 'string' || raw.owner.login.toLowerCase() !== USER) {
      throw new RepositoryError('GitHub returned an unexpected repository record. Please try again.', 'data');
    }
    return {
      id: raw.id,
      name: raw.name,
      url: 'https://github.com/' + USER + '/' + encodeURIComponent(raw.name),
      description: cleanText(raw.description),
      language: cleanText(raw.language),
      topics: Array.isArray(raw.topics) ? [...new Set(raw.topics.filter(topic => typeof topic === 'string').map(cleanText))].filter(Boolean) : [],
      stars: Number.isSafeInteger(raw.stargazers_count) && raw.stargazers_count > 0 ? raw.stargazers_count : 0,
      fork: raw.fork === true,
      archived: raw.archived === true,
      updatedAt: validDate(raw.updated_at),
      pushedAt: validDate(raw.pushed_at)
    };
  }

  function rateLimitMessage(response) {
    const seconds = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(seconds) && seconds > Date.now() / 1000 && seconds < Date.now() / 1000 + 86400) {
      const time = new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return 'GitHub has reached its request limit for this connection. Try refreshing after ' + time + '.';
    }
    return 'GitHub has reached its request limit for this connection. Please try again later.';
  }

  function retryAt(response, now = Date.now()) {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const retry = response.headers.get('retry-after');
    const after = retry ? (/^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : 0;
    const valid = [reset, after].filter(value => Number.isFinite(value) && value > now && value <= now + 86400000);
    return valid.length ? Math.max(...valid) + 1000 : now + 60000;
  }

  function readBackoff(storage, now = Date.now()) {
    try {
      const value = Number(storage.getItem(BACKOFF_KEY));
      return Number.isFinite(value) && value > now && value <= now + 86401000 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function saveBackoff(storage, value) {
    try { storage.setItem(BACKOFF_KEY, String(value)); } catch (_) {}
  }

  function isFreshCache(cached, now = Date.now()) {
    const age = now - Date.parse(cached?.savedAt);
    return Number.isFinite(age) && age >= 0 && age < CACHE_MAX_AGE;
  }

  async function fetchRepositories(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs || 15000;
    const repositories = new Map();
    for (let page = 1; ; page += 1) {
      if (options.onPage) options.onPage(page);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let rows;
      try {
        const response = await fetchImpl(API + '?type=owner&sort=full_name&direction=asc&per_page=' + PAGE_SIZE + '&page=' + page, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response.ok) {
          if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')))) {
            throw new RepositoryError(rateLimitMessage(response), 'rate-limit', retryAt(response));
          }
          throw new RepositoryError('GitHub could not return the repositories (HTTP ' + response.status + '). Please try again.', 'http');
        }
        rows = await response.json();
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
          throw new RepositoryError('GitHub returned an unexpected response. Please try again.', 'data');
        }
      } catch (error) {
        if (error instanceof RepositoryError) throw error;
        if (controller.signal.aborted) {
          throw new RepositoryError('GitHub took too long to respond. Please try again.', 'timeout');
        }
        if (error instanceof SyntaxError) {
          throw new RepositoryError('GitHub returned an unreadable response. Please try again.', 'data');
        }
        throw new RepositoryError('Could not reach GitHub. Check your connection and try again.', 'network');
      } finally {
        clearTimeout(timer);
      }
      const previousSize = repositories.size;
      rows.forEach(raw => {
        const repository = normalizeRepository(raw);
        repositories.set(repository.id, repository);
      });
      if (rows.length < PAGE_SIZE) break;
      if (repositories.size === previousSize) {
        throw new RepositoryError('GitHub repeated a results page. Please refresh to load the complete list.', 'pagination');
      }
    }
    return [...repositories.values()];
  }

  function normalizeSnapshot(cached) {
    try {
      if (cached?.version !== 1 || cached.owner !== USER || !Array.isArray(cached.repositories)) return null;
      const savedAt = validDate(cached.savedAt);
      if (!savedAt || Date.parse(savedAt) > Date.now() + 300000) return null;
      const repositories = cached.repositories.map(repository => normalizeRepository({
        id: repository.id,
        name: repository.name,
        private: false,
        owner: { login: USER },
        description: repository.description,
        language: repository.language,
        topics: repository.topics,
        stargazers_count: repository.stars,
        fork: repository.fork,
        archived: repository.archived,
        updated_at: repository.updatedAt,
        pushed_at: repository.pushedAt
      }));
      if (new Set(repositories.map(repository => repository.id)).size !== repositories.length) return null;
      return { repositories, savedAt };
    } catch (_) {
      return null;
    }
  }

  function readCache(storage) {
    try { return normalizeSnapshot(JSON.parse(storage.getItem(CACHE_KEY))); } catch (_) { return null; }
  }

  async function fetchSnapshot(options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
    try {
      const response = await (options.fetchImpl || globalThis.fetch.bind(globalThis))('repositories.json', {
        signal: controller.signal, credentials: 'omit', cache: 'no-cache'
      });
      if (!response.ok) return null;
      return normalizeSnapshot(await response.json());
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function writeCache(storage, repositories, savedAt) {
    try {
      storage.setItem(CACHE_KEY, JSON.stringify({ version: 1, owner: USER, savedAt, repositories }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function selectRepositories(repositories, query = '', filter = 'all', sort = 'updated') {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = repositories.filter(repository => {
      if (filter === 'original' && repository.fork) return false;
      if (filter === 'forks' && !repository.fork) return false;
      if (filter === 'archived' && !repository.archived) return false;
      const text = [repository.name, repository.description, repository.language, ...repository.topics].join(' ').toLowerCase();
      return words.every(word => text.includes(word));
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    return matches.sort((a, b) => {
      if (sort === 'name') return byName(a, b);
      if (sort === 'stars') return b.stars - a.stars || byName(a, b);
      return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || byName(a, b);
    });
  }

  function start(document, storage) {
    const element = id => document.getElementById(id);
    const list = element('repos');
    if (!list) return;
    const state = { repositories: [], available: false, filter: 'all', loading: false, savedAt: null, retryAt: readBackoff(storage) };
    let retryTimer;
    const create = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const dateLabel = value => new Date(value).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    function card(repository, featured = false) {
      const article = create('article', 'repo-card' + (featured ? ' featured-card' : ''));
      const top = create('div', 'repo-topline');
      top.append(create('span', 'repo-badge', repository.fork ? 'Fork' : 'Public'));
      if (repository.archived) top.append(create('span', 'repo-badge', 'Archived'));
      const arrow = create('span', 'repo-link-icon', '\u2197');
      arrow.setAttribute('aria-hidden', 'true');
      top.append(arrow);
      const heading = create('h3', 'repo-name');
      const link = create('a', '', repository.name);
      link.href = repository.url;
      heading.append(link);
      const description = create('p', 'repo-description', repository.description || 'No description added on GitHub.');
      article.append(top, heading, description);
      if (repository.topics.length) {
        const topics = create('div', 'repo-topics');
        repository.topics.slice(0, 4).forEach(topic => topics.append(create('span', 'repo-topic', topic)));
        article.append(topics);
      }
      const meta = create('div', 'repo-meta');
      if (repository.language) meta.append(create('span', 'repo-language', repository.language));
      meta.append(create('span', 'repo-star', repository.stars + (repository.stars === 1 ? ' star' : ' stars')));
      if (repository.updatedAt) {
        const updated = create('time', 'repo-updated', 'Updated ' + new Date(repository.updatedAt).toLocaleDateString([], {
          year: 'numeric', month: 'short', day: 'numeric'
        }));
        updated.dateTime = repository.updatedAt;
        updated.title = dateLabel(repository.updatedAt);
        meta.append(updated);
      }
      article.append(meta);
      return article;
    }

    function render() {
      const matches = selectRepositories(state.repositories, element('repo-search')?.value || '', state.filter, element('repo-sort')?.value || 'updated');
      const fragment = document.createDocumentFragment();
      matches.forEach(repository => fragment.append(card(repository)));
      list.replaceChildren(fragment);
      element('repo-count').textContent = state.available
        ? matches.length + ' of ' + state.repositories.length + ' public repositories'
        : 'Loading repositories';
      const empty = element('repo-empty');
      empty.hidden = !state.available || matches.length > 0;
      empty.textContent = state.repositories.length ? 'No repositories match these filters.' : 'No public repositories yet.';
      if (state.available) {
        const featured = element('featured');
        const selected = FEATURED.map(name => state.repositories.find(repository => repository.name.toLowerCase() === name)).filter(Boolean);
        featured.replaceChildren(...selected.map(repository => card(repository, true)));
        if (!selected.length) featured.append(create('p', 'repo-state', 'No featured projects are available.'));
      }
      document.querySelectorAll('#repo-filters [data-filter]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
      });
    }

    function setSavedStatus(message) {
      const status = element('sync-status');
      status.replaceChildren(create('span', '', (state.available ? 'Saved ' + dateLabel(state.savedAt) + '. ' : '') + message + ' '));
      const link = create('a', '', 'View on GitHub');
      link.href = 'https://github.com/' + USER + '?tab=repositories';
      status.append(link);
    }

    function updateRefresh() {
      clearTimeout(retryTimer);
      const refresh = element('refresh-repos');
      const waiting = state.retryAt > Date.now();
      refresh.disabled = state.loading || waiting;
      refresh.setAttribute('aria-busy', String(state.loading));
      refresh.title = waiting ? 'Try again after ' + new Date(state.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      if (waiting && !state.loading) retryTimer = setTimeout(() => {
        state.retryAt = 0;
        saveBackoff(storage, 0);
        updateRefresh();
        setSavedStatus('You can check for updates now.');
      }, state.retryAt - Date.now() + 50);
    }

    function showBackoff() {
      const time = new Date(state.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setSavedStatus('GitHub refresh is available after ' + time + '.');
      element('repo-loading').hidden = true;
      if (!state.available) element('repo-count').textContent = 'List unavailable';
      updateRefresh();
    }

    async function load() {
      if (state.loading) return;
      if (state.retryAt > Date.now()) { showBackoff(); return; }
      state.loading = true;
      updateRefresh();
      element('repo-loading').hidden = state.available;
      if (!state.available) element('repo-count').textContent = 'Loading public repositories...';
      element('repo-error').hidden = true;
      const status = element('sync-status');
      const savedMessage = state.available ? ' Saved ' + dateLabel(state.savedAt) + '.' : '';
      status.textContent = 'Checking for updates.' + savedMessage;
      try {
        const repositories = await fetchRepositories({
          onPage(page) {
            if (page > 1) status.textContent = 'Reading GitHub results, page ' + page + '.' + savedMessage;
          }
        });
        state.repositories = repositories;
        state.available = true;
        state.savedAt = new Date().toISOString();
        state.retryAt = 0;
        saveBackoff(storage, 0);
        writeCache(storage, repositories, state.savedAt);
        render();
        status.textContent = 'Checked ' + dateLabel(state.savedAt) + '.';
      } catch (error) {
        render();
        if (error.kind === 'rate-limit') {
          state.retryAt = error.retryAt;
          saveBackoff(storage, state.retryAt);
        }
        if (state.available) {
          if (state.retryAt > Date.now()) showBackoff();
          else setSavedStatus("Couldn't check for updates.");
        } else {
          const errorBox = element('repo-error');
          errorBox.textContent = error.message;
          errorBox.hidden = false;
          element('repo-count').textContent = 'List unavailable';
          setSavedStatus('The repository list could not be loaded.');
        }
      } finally {
        state.loading = false;
        updateRefresh();
        element('repo-loading').hidden = true;
      }
    }

    const year = element('year');
    if (year) year.textContent = String(new Date().getFullYear());
    const cached = readCache(storage);
    if (cached) {
      state.repositories = cached.repositories;
      state.savedAt = cached.savedAt;
      state.available = true;
    }
    render();
    element('repo-search')?.addEventListener('input', render);
    element('repo-sort')?.addEventListener('change', render);
    document.querySelectorAll('#repo-filters [data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        state.filter = ['all', 'original', 'forks', 'archived'].includes(button.dataset.filter) ? button.dataset.filter : 'all';
        render();
      });
    });
    element('refresh-repos').addEventListener('click', load);
    async function initialize() {
      const refresh = element('refresh-repos');
      refresh.disabled = true;
      if (!isFreshCache(cached)) {
        const snapshot = await fetchSnapshot();
        if (snapshot && (!state.available || Date.parse(snapshot.savedAt) > Date.parse(state.savedAt))) {
          state.repositories = snapshot.repositories;
          state.savedAt = snapshot.savedAt;
          state.available = true;
          render();
        }
      }
      if (state.retryAt > Date.now()) { showBackoff(); return; }
      if (isFreshCache(cached)) {
        element('repo-loading').hidden = true;
        element('sync-status').textContent = 'Checked ' + dateLabel(state.savedAt) + '.';
        updateRefresh();
        return;
      }
      load();
    }
    initialize();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { USER, CACHE_KEY, BACKOFF_KEY, CACHE_MAX_AGE, RepositoryError, normalizeRepository, normalizeSnapshot, fetchRepositories, fetchSnapshot, readCache, writeCache, readBackoff, retryAt, isFreshCache, selectRepositories };
  }
  if (typeof window !== 'undefined' && window.document) {
    let storage;
    try { storage = window.localStorage; } catch (_) { storage = null; }
    start(window.document, storage);
  }
}());
