// Starter tasks for common Malaysian university projects.
// `week` is the semester week the task is due (on the Friday), counted from the project's Week 1 Monday.

export const TEMPLATES = {
  blank: { name: 'Empty project', tasks: [] },

  fyp: {
    name: 'Final Year Project (FYP)',
    tasks: [
      { week: 1, title: 'Confirm FYP title and supervisor' },
      { week: 2, title: 'First meeting with supervisor' },
      { week: 3, title: 'Chapter 1: Introduction' },
      { week: 5, title: 'Chapter 2: Literature review' },
      { week: 7, title: 'Chapter 3: Methodology' },
      { week: 9, title: 'Proposal presentation', important: true },
      { week: 10, title: 'System design: use case, ERD and UI mockups' },
      { week: 12, title: 'Build the prototype' },
      { week: 13, title: 'Check similarity on Turnitin and submit report', important: true },
      { week: 14, title: 'Final presentation and demo', important: true },
    ],
  },

  group: {
    name: 'Group assignment',
    tasks: [
      { week: 1, title: 'Split the work and agree on group rules' },
      { week: 2, title: 'Find references' },
      { week: 4, title: 'Write my part of the report' },
      { week: 5, title: 'Combine and proofread the report' },
      { week: 5, title: 'Make the slides' },
      { week: 6, title: 'Submit on the learning portal', important: true },
      { week: 6, title: 'Peer evaluation form' },
    ],
  },
};

// Friday of the given semester week, as YYYY-MM-DD. Null when there's no Week 1 date.
export function dueForWeek(semStart, week) {
  if (!semStart) return null;
  const d = new Date(`${semStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + 4);
  return d.toISOString().slice(0, 10);
}
