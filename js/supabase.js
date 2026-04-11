// ===================================================================
// SHARED STATE — mutable state accessible by all modules
// ===================================================================

const state = {
  sb: null,
  PROJECTS: [],
  allTasks: [],
  allChores: [],
  allChoreCompletions: [],
  currentView: 'projects',
};

export default state;

// Constants
export const IDEAS_KEY = 'claw_cc_ideas';
export const THEME_KEY = 'claw_cc_theme';
export const ARCHIVED_PROJECTS_KEY = 'claw_cc_archived_projects';
export const SHOW_ARCHIVED_KEY = 'claw_cc_show_archived';
export const CURRENT_VIEW_KEY = 'claw_cc_current_view';
export const STAY_CONNECTED_KEY = 'claw_cc_stay_connected';
export const MAX_TEXT_LEN = 5000;
export const MAX_META_DISPLAY = 500;
export const TODO_MAX_LEN = 2000;
export const CHORE_CATEGORIES_KEY = 'claw_cc_chore_categories';
