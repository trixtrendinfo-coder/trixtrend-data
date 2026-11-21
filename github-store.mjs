import { setTimeout as pause } from 'node:timers/promises';
import { Buffer } from 'node:buffer';

const paths = new Set(['session.enc.json', 'quant-gold.json']);

export class GitHubStore {
  constructor({ repository, token, fetcher = fetch }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
      throw new Error('Missing repository or workflow token');
    }
    this.repository = repository;
    this.token = token;
    this.fetcher = fetcher;
  }
  async call(path, options = {}) {
    if (!paths.has(path)) throw new Error('Write path is not allowed');
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/contents/${path}`, {
      ...options,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 404 && !options.method) return null;
    if (!response.ok) throw new Error(`GitHub storage request failed (${response.status})`);
    return response.json();
  }
  async read(path) {
    const entry = await this.call(path);
    if (!entry) return null;
    if (!entry.content || !entry.sha || entry.encoding !== 'base64') throw new Error('Invalid GitHub file response');
    return { sha: entry.sha, value: JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8')) };
  }
  async write(path, value, message) {
    const content = Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64');
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.read(path);
      try {
        return await this.call(path, { method: 'PUT', body: JSON.stringify({ message, content,
          branch: 'main', ...(current ? { sha: current.sha } : {}) }) });
      } catch (error) {
        if (attempt === 2) throw error;
        await pause(1500 * (attempt + 1));
      }
    }
  }
}
