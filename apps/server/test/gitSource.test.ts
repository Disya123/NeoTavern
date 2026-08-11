import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@neotavern/shared';
import { buildArchiveUrl, downloadRepoArchive, parseGitRepoUrl } from '../src/plugin/gitSource.js';

describe('parseGitRepoUrl', () => {
  it('parses plain GitHub repository URLs', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('normalizes .git suffix, trailing slash and www prefix', () => {
    expect(parseGitRepoUrl('https://www.github.com/owner/repo.git/')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('extracts the ref from /tree/ paths including nested branches', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo/tree/v1.2.3')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      ref: 'v1.2.3',
    });
    expect(parseGitRepoUrl('https://github.com/owner/repo/tree/feature/deep/branch')).toEqual({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      ref: 'feature/deep/branch',
    });
  });

  it('parses GitLab URLs the same way', () => {
    expect(parseGitRepoUrl('https://gitlab.com/group/project/tree/main')).toEqual({
      host: 'gitlab.com',
      owner: 'group',
      repo: 'project',
      ref: 'main',
    });
  });

  it('rejects malformed and insecure URLs with stable codes', () => {
    const cases: Array<[string, string, string]> = [
      ['not a url', 'PLUGIN_SOURCE_INVALID', 'REPO_URL_MALFORMED'],
      ['', 'PLUGIN_SOURCE_INVALID', 'REPO_URL_REQUIRED'],
      ['http://github.com/owner/repo', 'PLUGIN_SOURCE_INVALID', 'REPO_URL_INSECURE'],
      ['https://github.com/owner', 'PLUGIN_SOURCE_INVALID', 'REPO_PATH_INCOMPLETE'],
      ['https://github.com/own er/repo', 'PLUGIN_SOURCE_INVALID', 'REPO_PATH_INVALID'],
      ['https://github.com/owner/repo/tree/', 'PLUGIN_SOURCE_UNSUPPORTED', 'REPO_URL_SHAPE'],
      ['https://github.com/owner/repo/blob/main/x', 'PLUGIN_SOURCE_UNSUPPORTED', 'REPO_URL_SHAPE'],
    ];
    for (const [input, code, reason] of cases) {
      let error: unknown;
      try {
        parseGitRepoUrl(input);
      } catch (caught) {
        error = caught;
      }
      expect(isAppError(error), input).toBe(true);
      if (isAppError(error)) {
        expect(error.code, input).toBe(code);
        expect(error.params['reason'], input).toBe(reason);
      }
    }
  });

  it('rejects unsupported hosts and schemes', () => {
    const cases: Array<[string, string]> = [
      ['https://bitbucket.org/owner/repo', 'REPO_HOST'],
      ['ftp://github.com/owner/repo', 'REPO_URL_SCHEME'],
    ];
    for (const [input, reason] of cases) {
      let error: unknown;
      try {
        parseGitRepoUrl(input);
      } catch (caught) {
        error = caught;
      }
      expect(isAppError(error), input).toBe(true);
      if (isAppError(error)) {
        expect(error.code, input).toBe('PLUGIN_SOURCE_UNSUPPORTED');
        expect(error.params['reason'], input).toBe(reason);
      }
    }
  });
});

describe('buildArchiveUrl', () => {
  it('uses codeload with HEAD for GitHub default branches', () => {
    expect(buildArchiveUrl({ host: 'github.com', owner: 'owner', repo: 'repo' })).toBe(
      'https://codeload.github.com/owner/repo/tar.gz/HEAD',
    );
  });

  it('encodes refs with slashes for GitHub', () => {
    expect(
      buildArchiveUrl({ host: 'github.com', owner: 'owner', repo: 'repo', ref: 'feature/x' }),
    ).toBe('https://codeload.github.com/owner/repo/tar.gz/feature%2Fx');
  });

  it('builds the GitLab archive URL with dashed file names', () => {
    expect(
      buildArchiveUrl({ host: 'gitlab.com', owner: 'group', repo: 'project', ref: 'feature/x' }),
    ).toBe('https://gitlab.com/group/project/-/archive/feature%2Fx/project-feature-x.tar.gz');
  });

  it('refuses GitLab without an explicit ref', () => {
    let error: unknown;
    try {
      buildArchiveUrl({ host: 'gitlab.com', owner: 'group', repo: 'project' });
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.params['reason']).toBe('GITLAB_REF_REQUIRED');
  });
});

describe('downloadRepoArchive', () => {
  const gzipBody = gzipSync(Buffer.from('plugin archive payload'));

  function okResponse(body: Buffer = gzipBody): Response {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/gzip', 'content-length': String(body.length) },
    });
  }

  it('downloads a gzip archive atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-'));
    const target = join(root, 'repo.tar.gz');
    await downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', target, {
      fetchImpl: async () => okResponse(),
    });
    expect(await readFile(target)).toEqual(gzipBody);
  });

  it('rejects responses that are not gzip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-nogz-'));
    const target = join(root, 'repo.tar.gz');
    await expect(
      downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', target, {
        fetchImpl: async () => new Response(Buffer.from('plain text'), { status: 200 }),
      }),
    ).rejects.toThrow('REPO_NOT_GZIP');
  });

  it('rejects non-success statuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-404-'));
    await expect(
      downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'a.tgz'), {
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toThrow('REPO_ARCHIVE_UNAVAILABLE');
  });

  it('enforces the byte cap while streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-cap-'));
    await expect(
      downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'a.tgz'), {
        maxBytes: 4,
        fetchImpl: async () => okResponse(),
      }),
    ).rejects.toThrow('REPO_ARCHIVE_TOO_LARGE');
  });

  it('follows HTTPS redirects and refuses insecure hops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-redir-'));
    const seen: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      seen.push(input);
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/final.tar.gz' },
        });
      }
      return okResponse();
    };
    await downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'a.tgz'), {
      fetchImpl,
    });
    expect(seen).toEqual([
      'https://codeload.github.com/o/r/tar.gz/HEAD',
      'https://cdn.example.com/final.tar.gz',
    ]);

    await expect(
      downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'b.tgz'), {
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } }),
      }),
    ).rejects.toThrow('REPO_URL_INSECURE');
  });

  it('stops after too many redirects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-loop-'));
    await expect(
      downloadRepoArchive('https://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'a.tgz'), {
        fetchImpl: async (input) =>
          new Response(null, { status: 302, headers: { location: input } }),
      }),
    ).rejects.toThrow('REPO_TOO_MANY_REDIRECTS');
  });

  it('honors an already aborted signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-abort-'));
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await downloadRepoArchive(
        'https://codeload.github.com/o/r/tar.gz/HEAD',
        join(root, 'a.tgz'),
        {
          signal: controller.signal,
          fetchImpl: async () => okResponse(),
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('ABORTED');
  });

  it('refuses to start from a non-https URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neotavern-gitsource-http-'));
    await expect(
      downloadRepoArchive('http://codeload.github.com/o/r/tar.gz/HEAD', join(root, 'a.tgz'), {
        fetchImpl: async () => okResponse(),
      }),
    ).rejects.toThrow('REPO_URL_INSECURE');
  });
});
