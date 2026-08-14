import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  downloadToFile,
  isForbiddenDestinationHost,
  writeResponseToDisk,
} from '../src/lib/httpDownload.js';

function okResponse(body = 'payload'): Response {
  return new Response(Buffer.from(body), { status: 200 });
}

async function makeDestination(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'neotavern-httpdl-'));
  return join(root, 'out.bin');
}

describe('isForbiddenDestinationHost (§SEC-03 URL-level policy)', () => {
  it('blocks loopback, link-local, multicast, unspecified and local names', () => {
    for (const host of [
      '127.0.0.1',
      '127.8.9.10',
      'localhost',
      'foo.localhost',
      'mybox.local',
      'srv.internal',
      '0.0.0.0',
      '169.254.169.254',
      '169.254.1.2',
      '224.0.0.1',
      '239.255.255.250',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isForbiddenDestinationHost(host), host).toBe(true);
    }
  });

  it('allows public hosts and private LAN ranges', () => {
    for (const host of [
      'registry.npmjs.org',
      'codeload.github.com',
      'cdn.example.com',
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.255',
      '192.168.1.5',
      'fd00::1',
      'fc00::1',
      '::ffff:10.0.0.5',
    ]) {
      expect(isForbiddenDestinationHost(host), host).toBe(false);
    }
  });
});

describe('downloadToFile (§SEC-03 hardening)', () => {
  it('refuses a loopback initial URL', async () => {
    await expect(
      downloadToFile('https://127.0.0.1:8443/evil.tgz', await makeDestination(), {
        maxBytes: 1024,
        fetchImpl: async () => okResponse(),
      }),
    ).rejects.toThrow('DESTINATION_DENIED');
  });

  it('re-validates every redirect hop against the policy', async () => {
    const dest = await makeDestination();
    let seen = 0;
    await expect(
      downloadToFile('https://cdn.example.com/a.tgz', dest, {
        maxBytes: 1024,
        fetchImpl: async () => {
          seen += 1;
          if (seen === 1) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://169.254.169.254/latest/meta-data' },
            });
          }
          return okResponse();
        },
      }),
    ).rejects.toThrow('DESTINATION_DENIED');
    expect(seen).toBe(1); // the poisoned hop is never fetched
  });

  it('refuses an insecure (http) redirect', async () => {
    await expect(
      downloadToFile('https://cdn.example.com/a.tgz', await makeDestination(), {
        maxBytes: 1024,
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } }),
      }),
    ).rejects.toThrow('URL_INSECURE');
  });

  it('stops after too many redirects', async () => {
    await expect(
      downloadToFile('https://cdn.example.com/a.tgz', await makeDestination(), {
        maxBytes: 1024,
        fetchImpl: async (input) =>
          new Response(null, { status: 302, headers: { location: input } }),
      }),
    ).rejects.toThrow('TOO_MANY_REDIRECTS');
  });

  it('follows valid redirects and writes the final body', async () => {
    const dest = await makeDestination();
    const seen: string[] = [];
    await downloadToFile('https://registry.npmjs.org/a.tgz', dest, {
      maxBytes: 1024,
      fetchImpl: async (input) => {
        seen.push(input);
        if (seen.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.com/final.tgz' },
          });
        }
        return okResponse();
      },
    });
    expect(seen).toEqual(['https://registry.npmjs.org/a.tgz', 'https://cdn.example.com/final.tgz']);
  });

  it('trustedHop exempts an operator-configured registry host', async () => {
    // A self-hosted registry may legitimately live on a local/private address.
    const dest = await makeDestination();
    await downloadToFile('https://127.0.0.1:4873/a.tgz', dest, {
      maxBytes: 1024,
      fetchImpl: async () => okResponse(),
      trustedHop: (url) => url.host === '127.0.0.1:4873',
    });
    // A redirect away from the trusted host is re-policed.
    let seen = 0;
    await expect(
      downloadToFile('https://127.0.0.1:4873/a.tgz', await makeDestination(), {
        maxBytes: 1024,
        fetchImpl: async () => {
          seen += 1;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://127.0.0.2:4873/evil.tgz' },
          });
        },
        trustedHop: (url) => url.host === '127.0.0.1:4873',
      }),
    ).rejects.toThrow('DESTINATION_DENIED');
    expect(seen).toBe(1);
  });
});

describe('free-space preflight (§SEC-04)', () => {
  it('fails before writing when the volume cannot hold the content', async () => {
    const dest = await makeDestination();
    await expect(
      writeResponseToDisk(
        new Response(Buffer.from('data'), {
          status: 200,
          headers: { 'content-length': '1000000' },
        }),
        dest,
        {
          maxBytes: 2_000_000,
          statfsImpl: async () => ({ bavail: 10, bsize: 512 }), // 5 KiB free
        },
      ),
    ).rejects.toThrow('DISK_SPACE');
  });

  it('uses the byte cap when content-length is unknown', async () => {
    const dest = await makeDestination();
    await expect(
      writeResponseToDisk(new Response(Buffer.from('data'), { status: 200 }), dest, {
        maxBytes: 64 * 1024 * 1024,
        statfsImpl: async () => ({ bavail: 100, bsize: 512 }), // far below the cap
      }),
    ).rejects.toThrow('DISK_SPACE');
  });

  it('passes when the volume has headroom and writes the body', async () => {
    const dest = await makeDestination();
    await writeResponseToDisk(new Response(Buffer.from('stored'), { status: 200 }), dest, {
      maxBytes: 1024,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4096 }),
    });
  });
});
