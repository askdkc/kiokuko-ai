import path from 'node:path';

export interface RecorderEnvironmentPlan {
  readonly environment: NodeJS.ProcessEnv;
  readonly directories: readonly string[];
}

/** Plan only: the caller creates these private directories before launching a recorder. */
export function recorderEnvironment(root: string, searchPath: string): RecorderEnvironmentPlan {
  const temporary = path.join(root, 'tmp');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const cache = path.join(root, 'cache');
  const state = path.join(root, 'state');
  return {
    environment: {
      PATH: searchPath, HOME: root, USERPROFILE: root,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state,
    },
    directories: [root, temporary, config, data, cache, state],
  };
}

