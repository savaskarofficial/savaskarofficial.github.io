'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CACHE_KEY, BACKOFF_KEY, CACHE_MAX_AGE, normalizeRepository, normalizeSnapshot, fetchRepositories, fetchSnapshot, readCache, writeCache, selectRepositories, isFreshCache, retryAt, readBackoff } = require('../app.js');

function raw(id, extra = {}) {
  return {
    id,
    name: 'project-' + String(id).padStart(3, '0'),
    private: false,
    owner: { login: 'savaskarofficial' },
    description: 'An Android tool',
    language: null,
    topics: ['android'],
    fork: false,
    archived: false,
    stargazers_count: 0,
    updated_at: '2026-01-01T12:00:00Z',
    pushed_at: '2026-01-01T12:00:00Z',
    ...extra
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('loads every page, including beyond 100, and includes profile, portfolio and forks', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => raw(index + 1));
  rows[0].name = 'savaskarofficial';
  rows[1].name = 'savaskarofficial.github.io';
  rows[2].fork = true;
  rows[3].archived = true;
  const requests = [];
  const repositories = await fetchRepositories({ fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    const query = new URL(url).searchParams;
    assert.equal(query.get('sort'), 'full_name');
    const page = Number(query.get('page'));
    return response(rows.slice((page - 1) * 100, page * 100));
  } });
  assert.equal(requests.length, 3);
  assert.equal(repositories.length, 205);
  assert.ok(repositories.some(repository => repository.name === 'savaskarofficial'));
  assert.ok(repositories.some(repository => repository.name === 'savaskarofficial.github.io'));
  assert.equal(repositories.filter(repository => repository.fork).length, 1);
  assert.equal(repositories.filter(repository => repository.archived).length, 1);
});

test('checks the next page when exactly 100 repositories are returned', async () => {
  let calls = 0;
  const repositories = await fetchRepositories({ fetchImpl: async () => response(++calls === 1 ? Array.from({ length: 100 }, (_, index) => raw(index + 1)) : []) });
  assert.equal(repositories.length, 100);
  assert.equal(calls, 2);
});

test('does not return a partial list or replace a complete cache after a later-page failure', async () => {
  const storage = memoryStorage();
  const saved = '2026-01-01T12:00:00.000Z';
  const original = [normalizeRepository(raw(999))];
  writeCache(storage, original, saved);
  let calls = 0;
  await assert.rejects(async () => {
    const repositories = await fetchRepositories({ fetchImpl: async () => ++calls === 1
      ? response(Array.from({ length: 100 }, (_, index) => raw(index + 1)))
      : response({ message: 'Unavailable' }, 503) });
    writeCache(storage, repositories, new Date().toISOString());
  }, error => error.kind === 'http');
  assert.deepEqual(readCache(storage), { repositories: original, savedAt: saved });
});

test('rejects a repeated full page instead of looping forever', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => raw(index + 1));
  await assert.rejects(fetchRepositories({ fetchImpl: async () => response(rows) }), error => error.kind === 'pagination');
});

test('reports rate limits separately from network errors', async () => {
  await assert.rejects(fetchRepositories({ fetchImpl: async () => response({}, 403, { 'x-ratelimit-remaining': '0' }) }), error => error.kind === 'rate-limit');
  await assert.rejects(fetchRepositories({ fetchImpl: async () => response({}, 429) }), error => error.kind === 'rate-limit');
  await assert.rejects(fetchRepositories({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), error => error.kind === 'network');
});

test('aborts a stalled request with a useful timeout state', async () => {
  await assert.rejects(fetchRepositories({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) }), error => error.kind === 'timeout');
});

test('rejects malformed API data, unexpected owners and private records', async () => {
  for (const body of [{ message: 'wrong shape' }, [raw(1, { owner: { login: 'someone-else' } })], [raw(1, { private: true })], [raw(1, { name: '../escape' })]]) {
    await assert.rejects(fetchRepositories({ fetchImpl: async () => response(body) }), error => error.kind === 'data');
  }
});

test('does not trust API URLs and normalizes descriptions without inventing language data', () => {
  const repository = normalizeRepository(raw(1, { html_url: 'javascript:alert(1)', description: 'Debugging \u2014 API tools', language: null }));
  assert.equal(repository.url, 'https://github.com/savaskarofficial/project-001');
  assert.equal(repository.description, 'Debugging - API tools');
  assert.equal(repository.language, '');
});

test('searches names, descriptions and topics while preserving the full source list', () => {
  const repositories = [
    normalizeRepository(raw(1, { name: 'covert', description: 'HTTP debugger', topics: ['api', 'proxy'], stargazers_count: 10 })),
    normalizeRepository(raw(2, { name: 'OsiNet', description: 'Investigation tools', topics: ['osint'], updated_at: '2026-02-01T00:00:00Z' })),
    normalizeRepository(raw(3, { name: 'archive', archived: true, fork: true }))
  ];
  assert.deepEqual(selectRepositories(repositories, 'HTTP proxy').map(repository => repository.name), ['covert']);
  assert.deepEqual(selectRepositories(repositories, 'OSINT').map(repository => repository.name), ['OsiNet']);
  assert.deepEqual(selectRepositories(repositories, '', 'forks').map(repository => repository.name), ['archive']);
  assert.equal(selectRepositories(repositories, '', 'original').length, 2);
  assert.equal(selectRepositories(repositories, '', 'archived').length, 1);
  assert.equal(selectRepositories(repositories, '', 'all', 'stars')[0].name, 'covert');
  assert.equal(selectRepositories(repositories)[0].name, 'OsiNet');
  assert.equal(repositories[0].name, 'covert');
});

test('cache handles disabled storage, malformed values and unsafe links', () => {
  assert.equal(readCache(null), null);
  assert.equal(writeCache(null, [], new Date().toISOString()), false);
  const storage = memoryStorage();
  storage.setItem(CACHE_KEY, '{broken');
  assert.equal(readCache(storage), null);
  const repository = normalizeRepository(raw(1));
  repository.url = 'javascript:alert(1)';
  assert.equal(writeCache(storage, [repository], '2026-01-01T12:00:00Z'), true);
  assert.equal(readCache(storage).repositories[0].url, 'https://github.com/savaskarofficial/project-001');
  storage.setItem(CACHE_KEY, JSON.stringify({ version: 1, owner: 'another-user', savedAt: '2026-01-01T12:00:00Z', repositories: [] }));
  assert.equal(readCache(storage), null);
});

test('blocked storage does not prevent a successful fetch and an empty result replaces stale cache', async () => {
  const blocked = {
    getItem() { throw new Error('Storage disabled'); },
    setItem() { throw new Error('Storage disabled'); }
  };
  assert.equal(readCache(blocked), null);
  const repositories = await fetchRepositories({ fetchImpl: async () => response([]) });
  assert.equal(writeCache(blocked, repositories, new Date().toISOString()), false);
  const storage = memoryStorage();
  writeCache(storage, [normalizeRepository(raw(1))], '2026-01-01T12:00:00Z');
  writeCache(storage, repositories, '2026-02-01T12:00:00Z');
  assert.deepEqual(readCache(storage), { repositories: [], savedAt: '2026-02-01T12:00:00.000Z' });
});

test('deduplicates overlapping page records by repository ID', async () => {
  let page = 0;
  const rows = Array.from({ length: 100 }, (_, index) => raw(index + 1));
  const repositories = await fetchRepositories({ fetchImpl: async () => response(++page === 1 ? rows : [raw(100), raw(101)]) });
  assert.equal(repositories.length, 101);
});

test('supports an account with no public repositories', async () => {
  const repositories = await fetchRepositories({ fetchImpl: async () => response([]) });
  assert.deepEqual(repositories, []);
});

test('bundled repository list is validated and cannot inject external links', async () => {
  const savedAt = '2026-01-01T12:00:00.000Z';
  const repository = normalizeRepository(raw(1));
  const snapshot = { version: 1, owner: 'savaskarofficial', savedAt, repositories: [{ ...repository, url: 'https://untrusted.example/' }] };
  assert.deepEqual(await fetchSnapshot({ fetchImpl: async () => response(snapshot) }), { savedAt, repositories: [repository] });
  assert.equal(normalizeSnapshot({ ...snapshot, owner: 'someone-else' }), null);
  assert.equal(normalizeSnapshot({ ...snapshot, repositories: [repository, repository] }), null);
  assert.equal(normalizeSnapshot({ ...snapshot, savedAt: new Date(Date.now() + 86400000).toISOString() }), null);
});

test('missing, broken or unavailable snapshot does not block a later live request', async () => {
  assert.equal(await fetchSnapshot({ fetchImpl: async () => response({}, 404) }), null);
  assert.equal(await fetchSnapshot({ fetchImpl: async () => new Response('invalid json') }), null);
  assert.equal(await fetchSnapshot({ fetchImpl: async () => { throw new TypeError('Network offline'); } }), null);
  assert.equal(await fetchSnapshot({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) }), null);
  assert.equal((await fetchRepositories({ fetchImpl: async () => response([raw(1)]) })).length, 1);
});

test('recent cache avoids repeated API calls but expires after ten minutes', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(isFreshCache({ savedAt: new Date(now - 1000).toISOString() }, now), true);
  assert.equal(isFreshCache({ savedAt: new Date(now - CACHE_MAX_AGE).toISOString() }, now), false);
  assert.equal(isFreshCache({ savedAt: new Date(now + 1000).toISOString() }, now), false);
  assert.equal(isFreshCache(null, now), false);
});

test('rate-limit reset and Retry-After are respected without accepting unreasonable dates', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const headers = { 'x-ratelimit-reset': String((now + 120000) / 1000), 'retry-after': '300' };
  assert.equal(retryAt(response({}, 403, headers), now), now + 301000);
  assert.equal(retryAt(response({}, 429, { 'retry-after': new Date(now + 120000).toUTCString() }), now), now + 121000);
  assert.equal(retryAt(response({}, 429, { 'x-ratelimit-reset': '99999999999999' }), now), now + 60000);
  const storage = memoryStorage();
  storage.setItem(BACKOFF_KEY, String(now + 121000));
  assert.equal(readBackoff(storage, now), now + 121000);
  assert.equal(readBackoff(storage, now + 122000), 0);
  storage.setItem(BACKOFF_KEY, String(now + 864000000));
  assert.equal(readBackoff(storage, now), 0);
  assert.equal(readBackoff(null, now), 0);
});

test('secondary rate limit provides a retry deadline even without primary quota headers', async () => {
  const now = Date.now();
  await assert.rejects(fetchRepositories({ fetchImpl: async () => response({}, 403, { 'retry-after': '120' }) }), error => {
    assert.equal(error.kind, 'rate-limit');
    assert.ok(error.retryAt >= now + 120000);
    return true;
  });
});
