import { readFileSync } from 'node:fs';
import { resourcePath } from '../core/paths.mjs';
import { SAFETY_SOURCE } from '../policy/actions.mjs';
import { semanticPage, diffSemanticPages, verifySemanticPage } from '../core/semantic-page.mjs';

const readSource = filename => readFileSync(resourcePath('src', 'browser', filename), 'utf8');
export const MAP_SRC = readSource('capabilities.js');
export const COLLECT_SRC = readSource('collect.js');

export function createBrowserSource({ currentTab = false, practiceKind = null } = {}) {
  const modules = ['dom.js', 'media.js', 'actions.js', 'dialogs.js', 'compiler.js'].map(readSource);
  const contract = 'window.__avSemanticPage=' + semanticPage.toString() + ';window.__avDiffPages=' + diffSemanticPages.toString()
    + ';window.__avVerifyPage=' + verifySemanticPage.toString() + ';';
  return SAFETY_SOURCE + ';window.__avCurrentTabOnly=' + !!currentTab + ';window.__avPracticeKind='
    + JSON.stringify(['practice', 'coding'].includes(practiceKind) ? practiceKind : null) + ';\n' + contract
    + modules.join('\n') + '\n' + readFileSync(resourcePath('extract.js'), 'utf8');
}
