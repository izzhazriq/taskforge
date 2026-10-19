// Reads a project's GitHub repository: recent commits, open pull requests and open issues.
// Public repositories work without a token; private ones need a personal access token from the profile page.
import { HttpError } from './errors.js';

// Accepts "owner/name" or a github.com link, and returns "owner/name".
export function parseRepo(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new HttpError(400, 'GitHub repository must be text.');
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!s) return '';
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m || m[2] === '.' || m[2] === '..') throw new HttpError(400, 'Use a GitHub repository like izzhazriq/taskforge, or its link.');
  return `${m[1]}/${m[2]}`;
}

// Task keys like MBSW-12 in a commit message, as { key: 'MBSW', number: 12 }, once each.
export function taskKeys(message) {
  const seen = new Map();
  for (const m of message.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})\b/g)) {
    const key = m[1].toUpperCase();
    seen.set(`${key}-${Number(m[2])}`, { key, number: Number(m[2]) });
  }
  return [...seen.values()];
}

const CACHE_MS = 60 * 1000;

export function githubClient({ fetch = globalThis.fetch } = {}) {
  const cache = new Map();

  // Answers are kept for a minute, so flicking between tabs doesn't use up GitHub's rate limit.
  // Only project members ever reach a repository's answers, so they can share them.
  async function get(path, token, { cached = true } = {}) {
    const key = `${token ? 'auth:' : ''}${path}`;
    const hit = cached && cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.data;
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'TaskForge',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });
    } catch {
      throw new HttpError(502, 'Couldn’t reach GitHub. Check your internet connection.');
    }
    if (res.status === 401) throw new HttpError(400, 'GitHub didn’t accept the token. Add a new one on your profile page.');
    if (res.status === 404) {
      throw new HttpError(404, token
        ? 'GitHub can’t find that repository, or your token can’t see it.'
        : 'GitHub can’t find that repository. If it’s private, add a GitHub token on your profile page.');
    }
    if (res.status === 403 || res.status === 429) {
      throw new HttpError(429, token
        ? 'GitHub says to slow down. Try again in a few minutes.'
        : 'GitHub limits how often TaskForge can check without a token. Add a token on your profile page, or try again later.');
    }
    if (!res.ok) throw new HttpError(502, `GitHub answered with an error (${res.status}). Try again later.`);
    const data = await res.json();
    if (cached) cache.set(key, { at: Date.now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return data;
  }

  // Everything the GitHub section shows, in one go.
  async function overview(repo, token) {
    const [info, commits, pulls, issues] = await Promise.all([
      get(`/repos/${repo}`, token),
      get(`/repos/${repo}/commits?per_page=20`, token).catch((err) => (err.status === 409 ? [] : Promise.reject(err))), // 409: empty repository
      get(`/repos/${repo}/pulls?state=open&per_page=10`, token),
      get(`/repos/${repo}/issues?state=open&per_page=30`, token),
    ]);
    const weekAgo = Date.now() - 7 * 86400000;
    return {
      repo: {
        full_name: info.full_name, url: info.html_url, description: info.description || '', private: Boolean(info.private),
        default_branch: info.default_branch, stars: info.stargazers_count, language: info.language || '',
        pushed_at: info.pushed_at, open_issues: issues.filter((i) => !i.pull_request).length, open_pulls: pulls.length,
      },
      commits: commits.map((c) => ({
        sha: c.sha.slice(0, 7), url: c.html_url, message: c.commit.message.split('\n')[0].slice(0, 200),
        author: c.author?.login || c.commit.author?.name || 'someone', date: c.commit.author?.date || c.commit.committer?.date,
        keys: taskKeys(c.commit.message),
      })),
      commits_this_week: commits.filter((c) => Date.parse(c.commit.author?.date) >= weekAgo).length,
      pulls: pulls.map((p) => ({
        number: p.number, title: p.title, url: p.html_url, author: p.user?.login || 'someone', draft: Boolean(p.draft),
        created_at: p.created_at, keys: taskKeys(`${p.title} ${p.head?.ref || ''}`),
      })),
      issues: issues.filter((i) => !i.pull_request).map((i) => ({
        number: i.number, title: i.title, url: i.html_url, author: i.user?.login || 'someone', created_at: i.created_at,
        labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).slice(0, 4),
      })),
    };
  }

  const issue = (repo, number, token) => get(`/repos/${repo}/issues/${number}`, token);
  const whoami = (token) => get('/user', token, { cached: false });

  return { overview, issue, whoami };
}
