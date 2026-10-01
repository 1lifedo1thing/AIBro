import { create as createHistory } from './edit-history.js';
import { mount as mountSource } from './source-editor.js';
import { mount as mountVisual } from './visual-editor.js';

globalThis.DocumentSourceEditor = Object.freeze({ mount: mountSource });
globalThis.DocumentVisualEditor = Object.freeze({ mount: mountVisual });

globalThis.DocumentEditHistory = Object.freeze({ create: createHistory });
