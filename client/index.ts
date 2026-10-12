/**
 * peq-link: the modernGraphTool ↔ uniPEQ link's reference client (docs/design.md §7.2).
 * Framework-free, no dependencies. mGT uses `startHost`/`resumeHost`, uniPEQ `startJoiner`.
 */
export * from './protocol.ts';
export * from './session.ts';
export * from './sync.ts';
export * from './liveness.ts';
export * from './host.ts';
export * from './joiner.ts';
