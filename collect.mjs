import fs from 'node:fs/promises';
import { GitHubStore } from './github-store.mjs';
import { collect } from './collector.mjs';

try {
  const baseline = JSON.parse(await fs.readFile(new URL('./baseline.json', import.meta.url), 'utf8'));
  const env = process.env;
  const result = await collect({ baseline,
    store: new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN }),
    stateKey: env.STATE_KEY, clientId: env.CTRADER_CLIENT_ID, clientSecret: env.CTRADER_CLIENT_SECRET,
    accountLogin: env.CTRADER_ACCOUNT_LOGIN, environment: env.CTRADER_ENVIRONMENT || 'live',
    bootstrapTokens: env.CTRADER_TOKEN_BUNDLE ? JSON.parse(env.CTRADER_TOKEN_BUNDLE) : undefined,
    publish: env.PUBLISH_DATA === 'true'
  });
  console.log(JSON.stringify(result));
} catch (error) {
  // Do not emit raw objects/stacks: third-party errors may contain token-bearing request URLs.
  const safe = typeof error?.message === 'string' &&
    !/https?:|token=|secret=|Bearer/i.test(error.message) ? error.message : 'Collector failed; existing chart retained';
  console.error(safe);
  process.exitCode = 1;
}
