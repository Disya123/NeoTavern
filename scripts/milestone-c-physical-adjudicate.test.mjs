import { describe, expect, it } from 'vitest';
import { REQUIRED_SERIAL } from './milestone-c-physical-capture.mjs';
import {
  adjudicateMilestoneC,
  gboardJourneyProven,
  talkbackJourneyProven,
} from './milestone-c-physical-adjudicate.mjs';

const gboardMarkers = `
gboard_ime focus=true epoch=1 production_cutover=false
gboard_ime inset_show px=900 epoch=2 production_cutover=false
gboard_ic action=setComposingText len=1 cursor=1 composing=true epoch=3 production_cutover=false
gboard_ic action=updateSelection start=1 end=1 epoch=4 production_cutover=false
gboard_ic action=deleteSurroundingText before=1 after=0 epoch=5 production_cutover=false
gboard_ic action=commitText len=1 cursor=1 epoch=6 production_cutover=false
gboard_ic action=performEditorAction code=SEND epoch=7 production_cutover=false
gboard_ime inset_hide px=0 epoch=8 production_cutover=false
gboard_ic action=lifecycle_resume composing=false len=0 epoch=9 production_cutover=false
`;

const talkbackMarkers = `
talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=header nodeId=1 recycle_jump=false visible_ids=a epoch=10 production_cutover=false
talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=messages nodeId=2 recycle_jump=false visible_ids=a epoch=11 production_cutover=false
talkback recycle_jump=false visible_ids=a epoch=12 production_cutover=false
talkback event=TYPE_VIEW_ACCESSIBILITY_FOCUSED node=composer nodeId=3 recycle_jump=false visible_ids=a epoch=13 production_cutover=false
talkback action=SCROLL_FORWARD node=messages nodeId=4 epoch=14 production_cutover=false
talkback event=TYPE_VIEW_CLICKED node=send nodeId=5 epoch=15 production_cutover=false
a11y_announce kind=stream_begin node=messages epoch=16 production_cutover=false
a11y_announce kind=stream_end node=messages epoch=17 production_cutover=false
talkback webview_in_tree=false epoch=18 production_cutover=false
talkback restored=true epoch=host production_cutover=false
`;

const harnessOnly = {
  stamp: '2026-08-18T22-44-36-756Z',
  serial: REQUIRED_SERIAL,
  emulator: false,
  production_cutover: 'NOT_STARTED',
  canary: false,
  production_jni_untouched: true,
  results: [
    { journey: 'flag_off', ok: true },
    { journey: 'live_open', ok: true, messageCount: 0 },
    { journey: 'jni_mapped', ok: true },
    { journey: 'launcher_untouched', ok: true },
    { journey: 'safe_mode', ok: true },
    { journey: 'a11y_semantics', ok: true },
    { journey: 'send', ok: true, after: { title: 'Hazel', count: 2 } },
    { journey: 'reopen', ok: true, after: { title: 'Hazel', count: 2 } },
    {
      journey: 'isolated_10k',
      ok: true,
      header: { title: 'Isolated 10k', count: 10_000 },
    },
    { journey: 'rotate', ok: true },
    { journey: 'background', ok: true },
    {
      journey: 'ime',
      ok: true,
      default_input_method:
        'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
      gboard: true,
    },
  ],
};

const passing = {
  ...harnessOnly,
  stamp: '2026-08-19T00-00-00-000Z',
  results: [
    ...harnessOnly.results,
    {
      journey: 'gboard_journey',
      ok: true,
      driver: 'gboard_keys',
      default_input_method:
        'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
      sendOnce: true,
      composingStuckAfterLifecycle: false,
      markers: gboardMarkers,
    },
    {
      journey: 'talkback_journey',
      ok: false,
      skipped: true,
      operator_waived: true,
      talkbackEnabled: false,
    },
  ],
};

describe('Milestone C physical journey adjudicator', () => {
  it('never stamps RFC Milestone C PASS or cutover', () => {
    const record = adjudicateMilestoneC(passing, 'live_wire=true production_cutover=false');
    expect(record.milestone_c).toBe('STARTED');
    expect(record.journey_batch).toBe('PASS');
    expect(record.production_cutover).toBe('NOT_STARTED');
    expect(record.canary).toBe(false);
    expect(record.almost_pass).toBe(false);
    expect(record.send_round_trip).toBe('PASS');
    expect(record.physical_10k).toBe('PASS');
    expect(record.gboard_journey).toBe('PASS');
    expect(record.talkback_journey).toBe('SKIPPED');
    expect(record.talkback_rfc51).toBe('DEFERRED_BY_OWNER');
    expect(record.product_accessibility_path).toBe('WEBVIEW_FALLBACK');
    expect(record.gboard_typing_insets_send).toBe('PASS');
    expect(record.ime_composition_contract).toBe('HOST_CONFORMANCE');
    expect(record.lifecycle).toBe('PASS');
    expect(record.safe_mode).toBe('PASS');
    expect(record.successful_attempt?.stamp).toBe(passing.stamp);
  });

  it('does not pass on send+10k+IME package+TalkBack semantics alone', () => {
    const record = adjudicateMilestoneC(
      harnessOnly,
      'live_wire=true production_cutover=false',
    );
    expect(record.journey_batch).toBe('FAIL');
    expect(record.gboard_environment).toBe('READY');
    expect(record.talkback_semantics).toBe('PASS');
    expect(record.gboard_journey).toBe('NOT_PROVEN');
    expect(record.talkback_journey).toBe('NOT_PROVEN');
    expect(record.reason).toMatch(/gboard_journey/u);
    expect(record.reason).not.toMatch(/talkback_journey/u);
  });

  it('accepts Gboard commitText when setComposingText is absent', () => {
    const markers = gboardMarkers.replace(
      /gboard_ic action=setComposingText[^\n]*\n/u,
      '',
    );
    expect(
      gboardJourneyProven(
        {
          ok: true,
          driver: 'gboard_keys',
          default_input_method:
            'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
          sendOnce: true,
          composingStuckAfterLifecycle: false,
          markers,
        },
        markers,
      ),
    ).toBe(true);
  });

  it('rejects adb input text as a Gboard journey', () => {
    expect(
      gboardJourneyProven(
        {
          ok: true,
          driver: 'adb_input_text',
          default_input_method:
            'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME',
          sendOnce: true,
          markers: gboardMarkers,
        },
        gboardMarkers,
      ),
    ).toBe(false);
  });

  it('rejects TalkBack semantics-only as a TalkBack journey', () => {
    expect(
      talkbackJourneyProven(
        {
          ok: true,
          semantics_only: true,
          talkbackEnabled: true,
          restored: true,
          webViewInTree: false,
          recycleJump: false,
          perTokenAnnounce: false,
          streamAnnounceCoalesced: true,
          focusOrder: ['header', 'messages', 'composer'],
          scrollAction: true,
          clickAction: true,
          markers: talkbackMarkers,
        },
        talkbackMarkers,
      ),
    ).toBe(false);
  });

  it('fails an emulator or the wrong serial', () => {
    const emu = adjudicateMilestoneC({ ...passing, emulator: true, serial: 'emulator-5554' });
    expect(emu.journey_batch).toBe('FAIL');
    expect(emu.physical).toBe(false);
    const other = adjudicateMilestoneC({ ...passing, serial: 'deadbeef' });
    expect(other.journey_batch).toBe('FAIL');
  });

  it('infers JNI from a live route when maps are empty', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: passing.results.map((row) =>
        row.journey === 'jni_mapped' ? { ...row, ok: false, inferred_from_live_route: true } : row,
      ),
    });
    expect(record.journey_batch).toBe('PASS');
    expect(record.checks.find((row) => row.id === 'jni_mapped')?.ok).toBe(true);
  });

  it('does not count send unless the message count grew', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: [
        ...passing.results.filter((row) => row.journey !== 'send' && row.journey !== 'live_open'),
        { journey: 'live_open', ok: true, messageCount: 0 },
        { journey: 'send', ok: true, after: { title: 'Hazel', count: 0 } },
      ],
    });
    expect(record.checks.find((row) => row.id === 'send')?.ok).toBe(false);
    expect(record.journey_batch).toBe('FAIL');
    expect(record.failed_attempts.some((row) => row.outcome === 'FAILED_ATTEMPT')).toBe(true);
  });

  it('keeps a prior FAILED_ATTEMPT stamp when a later batch passes', () => {
    const previous = {
      failed_attempts: [
        {
          stamp: '2026-08-18T21-55-58-696Z',
          outcome: 'FAILED_ATTEMPT',
          send_round_trip: 'FAIL',
        },
      ],
    };
    const record = adjudicateMilestoneC(
      passing,
      'live_wire=true production_cutover=false',
      previous,
    );
    expect(record.journey_batch).toBe('PASS');
    expect(record.failed_attempts).toEqual(previous.failed_attempts);
    expect(record.successful_attempt.stamp).toBe(passing.stamp);
  });

  it('fails when live_open is missing', () => {
    const record = adjudicateMilestoneC({
      ...passing,
      results: passing.results.map((row) =>
        row.journey === 'live_open' ? { ...row, ok: false } : row,
      ),
    });
    expect(record.journey_batch).toBe('FAIL');
    expect(record.admissible).toBe(false);
  });
});
