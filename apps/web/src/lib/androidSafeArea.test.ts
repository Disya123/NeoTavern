import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAndroidSafeArea } from './androidSafeArea.js';

describe('applyAndroidSafeArea', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    vi.unstubAllGlobals();
  });

  it('is a no-op without the Android bridge', () => {
    applyAndroidSafeArea();
    expect(document.documentElement.style.getPropertyValue('--nt-inset-top')).toBe('');
  });

  it('copies a valid host box onto :root', () => {
    vi.stubGlobal('__neotavernMobile', {
      safeAreaCss: () => '{"top":"24px","right":"0px","bottom":"32px","left":"0px"}',
    });
    applyAndroidSafeArea();
    expect(document.documentElement.style.getPropertyValue('--nt-inset-top')).toBe('24px');
    expect(document.documentElement.style.getPropertyValue('--nt-inset-bottom')).toBe('32px');
    expect(document.documentElement.style.getPropertyValue('--nt-safe-area-top')).toBe('24px');
  });

  it('rejects a malformed box', () => {
    vi.stubGlobal('__neotavernMobile', {
      safeAreaCss: () => '{"top":"24px;background:red","right":"0px","bottom":"0px","left":"0px"}',
    });
    applyAndroidSafeArea();
    expect(document.documentElement.style.getPropertyValue('--nt-inset-top')).toBe('');
  });

  it('does not write a 0×0 box over an already published inset', () => {
    document.documentElement.style.setProperty('--nt-inset-top', '24px');
    document.documentElement.style.setProperty('--nt-inset-bottom', '32px');
    vi.stubGlobal('__neotavernMobile', {
      safeAreaCss: () => '{"top":"0px","right":"0px","bottom":"0px","left":"0px"}',
    });
    applyAndroidSafeArea();
    expect(document.documentElement.style.getPropertyValue('--nt-inset-top')).toBe('24px');
    expect(document.documentElement.style.getPropertyValue('--nt-inset-bottom')).toBe('32px');
  });

  it('does not stamp 0px onto :root when the host has not measured yet', () => {
    vi.stubGlobal('__neotavernMobile', {
      safeAreaCss: () => '{"top":"0px","right":"0px","bottom":"0px","left":"0px"}',
    });
    applyAndroidSafeArea();
    expect(document.documentElement.style.getPropertyValue('--nt-inset-top')).toBe('');
  });
});
