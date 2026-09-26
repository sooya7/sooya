import type { ComponentType } from 'react';
import Now from './Now.js';
import Persona from './Persona.js';
import Look from './Look.js';
import Life from './Life.js';
import Memory from './Memory.js';
import Media from './Media.js';
import Chats from './Chats.js';
import Models from './Models.js';
import Qq from './Qq.js';
import Tools from './Tools.js';
import Video from './Video.js';
import Storage from './Storage.js';
import Ops from './Ops.js';

/** slug → page component; slugs must match ROUTES in ../routes.ts. */
export const PAGES: Record<string, ComponentType> = {
  '': Now,
  persona: Persona,
  look: Look,
  life: Life,
  memory: Memory,
  media: Media,
  chats: Chats,
  models: Models,
  qq: Qq,
  tools: Tools,
  video: Video,
  storage: Storage,
  ops: Ops,
};
