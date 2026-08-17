/**
 * Canonical presentation projection shared by React tests and the Dioxus
 * Product Wire shell. This is not a durable model; Kernel remains the owner.
 */

export const PRESENTATION_STREAM_CAP = 3;

export type PresentationStreamEvent = {
  generation: number;
  text: string;
};

export type PresentationStreamResult = {
  acceptedText: string;
  lastGeneration: number;
  droppedStale: number;
  droppedBackpressure: number;
};

export function applyPresentationStream(
  events: readonly PresentationStreamEvent[],
  cap: number = PRESENTATION_STREAM_CAP,
): PresentationStreamResult {
  if (cap < 1) {
    throw new Error('presentation stream cap must be at least 1');
  }
  let lastGeneration = 0;
  const accepted: string[] = [];
  let droppedStale = 0;
  let droppedBackpressure = 0;
  for (const event of events) {
    if (event.generation < lastGeneration) {
      droppedStale += 1;
      continue;
    }
    lastGeneration = event.generation;
    if (accepted.length >= cap) {
      droppedBackpressure += 1;
      continue;
    }
    accepted.push(event.text);
  }
  return {
    acceptedText: accepted.join(''),
    lastGeneration,
    droppedStale,
    droppedBackpressure,
  };
}
