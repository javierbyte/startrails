// The tool is served from this path on GitHub Pages and through the javier.xyz
// rewrite, in dev too. Shared with next.config.mjs so there is one source of
// truth for anything that has to build an absolute URL by hand: the worker,
// mainly, which the bundler does not rewrite for us.
export const BASE_PATH = '/startrails';
