/**
 * Single source of truth for coaching advice copy.
 *
 * The same five behaviours previously had advice written in five places
 * (coachPrograms.COACH_FOCUS_CATALOG, tripInsights.COACH_EVENT_DETAILS,
 * tripInsights.buildScoreTips, mediumInsights.eventRiskDefinitions, and the
 * now-deleted weeklyCoaching), and the wording had drifted apart. Those call
 * sites now compose from here so a wording change lands everywhere at once.
 *
 * Structural fields stay with their engines: metric field names and direction
 * live in coachPrograms, event-review-only entries live in tripInsights. Only
 * user-facing copy belongs here.
 *
 * Spoken alert wording is deliberately NOT here — voiceAlertMessages.js keeps
 * its own coaching/technical dual catalog because it is mirrored by the Android
 * native service and must stay in lockstep with it.
 */

export const COACHING_CONTENT = {
  harsh_brakes: {
    label: 'Progressive Braking',
    shortLabel: 'Brake earlier',
    eventLabel: 'Late braking',
    cue: 'Lift early, create space, then build brake pressure gradually.',
    liveCue: 'Today\'s focus is progressive braking. Lift early and build pressure smoothly.',
    drill: [
      'Choose the stop point earlier than usual.',
      'Lift off before applying the brake.',
      'Begin with light pressure and add force smoothly.',
    ],
    why: 'Hard braking is the clearest sign that stops are being handled late or with too little following room.',
    drillTitle: 'Five-stop anticipation drill',
    drillSteps: [
      'Pick five normal stops on the next trip.',
      'Lift off the accelerator before the lead vehicle starts braking.',
      'Aim for one smooth brake squeeze instead of a late hard press.',
    ],
    target: 'Reduce harsh-brake events on the next three normal trips.',
    riskCoaching: 'Brake earlier for the next five stops and leave one extra car length before intersections.',
    scoreTip: 'Most score loss is coming from harsh braking. Leave a larger following gap and lift off earlier before stops.',
  },
  rapid_accel: {
    label: 'Smoother Starts',
    shortLabel: 'Smooth acceleration',
    eventLabel: 'Hard acceleration',
    cue: 'Use a three-second throttle ramp after every full stop.',
    liveCue: 'Today\'s focus is smooth acceleration. Build throttle over three seconds.',
    drill: [
      'Settle the car fully at the stop.',
      'Add throttle progressively over three seconds.',
      'Reach cruise speed without a second surge.',
    ],
    why: 'Hard launches usually cost smoothness and fuel without saving much useful time.',
    drillTitle: 'Three-second throttle ramp',
    drillSteps: [
      'After each stop, count three seconds while adding throttle.',
      'Reach cruising speed progressively instead of jumping to it.',
      'Use the same ramp after slow turns and merges when traffic allows.',
    ],
    target: 'Keep rapid-acceleration events below your current weekly count.',
    riskCoaching: 'Use a three-second throttle ramp after stops so launches stay smoother.',
    scoreTip: 'Rapid acceleration is your biggest pattern. Try smoother throttle starts to improve smoothness and fuel cost.',
  },
  sharp_turns: {
    label: 'Cleaner Turns',
    shortLabel: 'Set corner speed',
    eventLabel: 'Sharp cornering',
    cue: 'Set speed before the turn and accelerate only as the wheel straightens.',
    liveCue: 'Today\'s focus is cleaner turns. Set speed before steering.',
    drill: [
      'Finish braking before meaningful steering input.',
      'Hold a calm, constant speed through the corner.',
      'Accelerate only as steering unwinds.',
    ],
    why: 'Sharp turns often mean speed is being adjusted during the turn instead of before it.',
    drillTitle: 'Brake-before-turn drill',
    drillSteps: [
      'Before each turn, finish most braking while the wheel is still straight.',
      'Hold steady speed through the middle of the turn.',
      'Accelerate only after the car starts straightening.',
    ],
    target: 'Complete the next city trip with fewer sharp-turn events.',
    riskCoaching: 'Set corner speed before turning, then accelerate only as the wheel straightens.',
    scoreTip: 'Sharp turns are showing up most often. Slow before corners, then accelerate after the car is straight.',
  },
  speeding: {
    label: 'Speed Discipline',
    shortLabel: 'Control speed creep',
    eventLabel: 'Speed control',
    cue: 'Choose a cruise target below the alert threshold and check after transitions.',
    liveCue: 'Today\'s focus is speed discipline. Settle below the alert threshold.',
    drill: [
      'Pick a target speed before joining the main road.',
      'Recheck speed after hills and road transitions.',
      'Use cruise control only when conditions make it appropriate.',
    ],
    why: 'Speed creep can build gradually, especially on familiar roads and highways.',
    drillTitle: 'Cruise-target reset',
    drillSteps: [
      'Choose a target speed before entering faster roads.',
      'Check speed after every major road change.',
      'Use cruise control where it is safe and appropriate.',
    ],
    target: 'Lower the percentage of samples above the configured threshold.',
    riskCoaching: 'Pick a cruise target 5 km/h below your alert threshold on repeated routes.',
    scoreTip: 'Speeding is your main risk event. Lowering cruise speed is the fastest way to improve safety score.',
  },
  phone_use: {
    label: 'Phone-Clear Driving',
    shortLabel: 'Remove phone exposure',
    eventLabel: 'Phone distraction',
    cue: 'Set navigation and audio before moving, then keep the phone out of reach.',
    liveCue: 'Today\'s focus is a phone-clear drive. Keep the phone out of reach.',
    drill: [
      'Enable Do Not Disturb before moving.',
      'Set navigation and audio while parked.',
      'Keep the device mounted or out of reach for the full trip.',
    ],
    why: 'Recent trips show enough phone-use risk to make attention the best coaching target.',
    drillTitle: 'Cabin setup routine',
    drillSteps: [
      'Start Do Not Disturb before driving.',
      'Place the phone out of reach or in a mount.',
      'Use voice navigation before the trip begins.',
    ],
    target: 'Record three phone-clear trips in a row.',
    riskCoaching: 'Set navigation and audio before moving, then keep the phone out of reach for the whole drive.',
    scoreTip: 'Phone use is your main risk pattern. Setting everything up before moving is the fastest fix.',
  },
  fatigue: {
    label: 'Fatigue-Aware Driving',
    shortLabel: 'Protect alertness',
    eventLabel: 'Alertness',
    cue: 'Plan a break before your learned fatigue window and stop if alertness drops.',
    liveCue: 'Today\'s focus is alertness. Take a break before fatigue builds.',
    drill: [
      'Check your alertness honestly before moving.',
      'Plan the break before the learned fatigue window.',
      'Stop somewhere safe if concentration or comfort drops.',
    ],
    why: 'Long or late drives raise risk well before tiredness feels obvious.',
    drillTitle: 'Planned-break routine',
    drillSteps: [
      'Decide the break point before starting a long drive.',
      'Take it on schedule even if you still feel fine.',
      'Stop earlier if concentration or comfort drops.',
    ],
    target: 'Take a planned break on every drive past your learned fatigue window.',
    riskCoaching: 'Plan a break before your learned fatigue window rather than pushing through it.',
    scoreTip: 'Long drives are shaping your score. A planned mid-drive break protects both alertness and smoothness.',
  },
  consistency: {
    label: 'Repeat Your Best Drive',
    shortLabel: 'Reuse your strongest setup',
    eventLabel: 'Consistency',
    cue: 'Recreate the route, timing, and calm first five minutes from your strongest comparable drive.',
    liveCue: 'Today\'s focus is repeating your strongest measured drive setup.',
    drill: [
      'Use a route and time window from a strong previous drive.',
      'Repeat its calm first five minutes.',
      'Compare the overall score only after another comparable drive.',
    ],
    why: 'No single risk event dominates, so the fastest gain is repeating the conditions of your best measured drives.',
    drillTitle: 'Best-drive replication',
    drillSteps: [
      'Pick your strongest recent comparable drive.',
      'Repeat its route and time of day.',
      'Protect the first five minutes from rushing.',
    ],
    target: 'Match or beat your best comparable drive score.',
    riskCoaching: 'Repeat the route, timing, and calm start of your strongest recent drive.',
    scoreTip: 'Focus on one behavior this week instead of all of them. Cutting the top event type will move the score fastest.',
  },
};

export const COACHING_CONTENT_IDS = Object.keys(COACHING_CONTENT);

export function coachingContentFor(focusId) {
  return COACHING_CONTENT[focusId] || COACHING_CONTENT.consistency;
}

/**
 * The copy-only subset consumed by COACH_FOCUS_CATALOG, so the program engine
 * keeps its structural fields (metric field, direction) without restating copy.
 */
export function coachingCopyFor(focusId) {
  const content = coachingContentFor(focusId);
  return {
    label: content.label,
    shortLabel: content.shortLabel,
    cue: content.cue,
    liveCue: content.liveCue,
    drill: content.drill,
  };
}

/**
 * The event-review subset consumed by COACH_EVENT_DETAILS.
 */
export function coachingEventDetailFor(focusId, focusArea) {
  const content = coachingContentFor(focusId);
  return {
    label: content.eventLabel,
    focus: focusArea,
    why: content.why,
    cue: content.cue,
    drillTitle: content.drillTitle,
    drillSteps: content.drillSteps,
    target: content.target,
  };
}
