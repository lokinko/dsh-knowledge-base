import controls from './client-base.css';
import workspace from './notes.css';
import editor from './editor.css';
import markdown from './markdown.css';
import coauthor from './coauthor.css';
import dialogs from './note-storage-ui.css';
import attachments from './attachment-ui.css';
import categories from './categories.css';
import workbench from './workbench.css';
import outline from './outline.css';
import topics from './topics.css';

// Vendor styles keep their existing owned scopes. Native conversation nodes never
// receive tm-bs or em-markdown, and custom rules target plugin-owned classes.
const bootstrapCss = __TODO_BOOTSTRAP_CSS__.replaceAll(
  '.tm-bs',
  ':is(.dn-workspace.tm-bs,.dn-workspace .tm-bs)',
);
const katexCss = __TODO_KATEX_CSS__.replaceAll('.em-markdown', '.dn-workspace .em-markdown');

export const workspaceCss = [
  `@layer nb-vendor {\n${bootstrapCss}\n}`,
  katexCss,
  controls,
  workspace,
  editor,
  markdown,
  coauthor,
  dialogs,
  attachments,
  categories,
  workbench,
  outline,
  topics,
].join('\n');
