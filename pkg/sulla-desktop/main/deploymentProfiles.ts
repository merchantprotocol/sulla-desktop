import fs from 'fs';
import os from 'os';
import { join } from 'path';
import stream from 'stream';

import _ from 'lodash';

import * as settings from '@pkg/config/settings';
import * as settingsImpl from '@pkg/config/settingsImpl';
import { appVariant } from '@pkg/utils/appVariant';
import { spawnFile } from '@pkg/utils/childProcess';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { RecursivePartial } from '@pkg/utils/typeUtils';

const console = Logging.deploymentProfile;

export class DeploymentProfileError extends Error {
  toString() {
    // This is needed on linux. Without it, we get a randomish replacement
    // for 'DeploymentProfileError' (like 'ys Error')
    return `DeploymentProfileError: ${ this.message }`;
  }
}

/**
 * Read and validate deployment profiles, giving system level profiles
 * priority over user level profiles.  If the system directory contains a
 * defaults or locked profile, the user directory will not be read.
 * @returns type validated defaults and locked deployment profiles, and throws
 *          an error if there is an error parsing the locked profile.
 */
export async function readDeploymentProfiles(): Promise<settings.DeploymentProfileType> {
  const profiles: settings.DeploymentProfileType = {
    defaults: {},
    locked:   {},
  };
  let defaults: undefined | RecursivePartial<settings.Settings>;
  let locked: undefined | RecursivePartial<settings.Settings>;
  let fullDefaultPath = '';
  let fullLockedPath = '';

  switch (os.platform()) {
  case 'linux': {
    const linuxPaths = {
      [paths.deploymentProfileSystem]:    ['defaults.json', 'locked.json'],
      [paths.altDeploymentProfileSystem]: ['defaults.json', 'locked.json'],
      ...(appVariant.id === 'production' ? { [paths.deploymentProfileUser]: ['sulla-desktop.defaults.json', 'sulla-desktop.locked.json'] } : {}),
    };

    for (const configDir in linuxPaths) {
      const [defaultPath, lockedPath] = linuxPaths[configDir];

      [defaults, locked] = parseJsonFiles(configDir, defaultPath, lockedPath);
      fullDefaultPath = join(configDir, defaultPath);
      fullLockedPath = join(configDir, lockedPath);
      if (typeof defaults !== 'undefined' || typeof locked !== 'undefined') {
        break;
      }
    }
    break;
  }

  case 'darwin':
    for (const rootPath of [paths.deploymentProfileSystem, paths.altDeploymentProfileSystem,
      ...(appVariant.id === 'production' ? [paths.deploymentProfileUser] : [])]) {
      [defaults, locked] = await parseJsonFromPlists(rootPath, 'io.sulla.desktop.profile.defaults.plist', 'io.sulla.desktop.profile.locked.plist');
      fullDefaultPath = join(rootPath, 'io.sulla.desktop.profile.defaults.plist');
      fullLockedPath = join(rootPath, 'io.sulla.desktop.profile.locked.plist');
      if (typeof defaults !== 'undefined' || typeof locked !== 'undefined') {
        break;
      }
    }
    break;
  }
  if (defaults) {
    if (!('version' in defaults)) {
      throw new DeploymentProfileError(`Invalid deployment file ${ fullDefaultPath }: no version specified. You'll need to add a version field to make it valid (current version is ${ settings.CURRENT_SETTINGS_VERSION }).`);
    }
    defaults = settingsImpl.migrateSpecifiedSettingsToCurrentVersion(defaults, false);
  }
  if (locked) {
    if (!('version' in locked)) {
      throw new DeploymentProfileError(`Invalid deployment file ${ fullLockedPath }: no version specified. You'll need to add a version field to make it valid (current version is ${ settings.CURRENT_SETTINGS_VERSION }).`);
    }
    locked = settingsImpl.migrateSpecifiedSettingsToCurrentVersion(locked, true);
  }

  profiles.defaults = validateDeploymentProfile(fullDefaultPath, defaults, settings.defaultSettings, []) ?? {};
  profiles.locked = validateDeploymentProfile(fullLockedPath, locked, settings.defaultSettings, []) ?? {};

  return profiles;
}

// This function can't call `plutil` directly with `inputPath`, because unit-testing mocks `fs.readFileSync`
// So read the text into a string variable, and have `plutil` read it via stdin.
// It's no error if a deployment profile doesn't exist.
// Any other error needs to show up in a dialog box and terminate processing.
async function convertAndParsePlist(inputPath: string): Promise<undefined | RecursivePartial<settings.Settings>> {
  let plutilResult: { stdout?: string, stderr?: string };
  let body: stream.Readable;
  const args = ['-convert', 'json', '-r', '-o', '-', '-'];
  const getErrorString = (error: any) => error.stdout || error.stderr || error.toString();

  try {
    body = stream.Readable.from(fs.readFileSync(inputPath));
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return;
    }
    console.log(`Error reading file ${ inputPath }\n${ error }`);
    throw new DeploymentProfileError(`Error reading file ${ inputPath }: ${ getErrorString(error) }`);
  }
  try {
    plutilResult = await spawnFile('plutil', args, { stdio: [body, 'pipe', 'pipe'] });
  } catch (error: any) {
    console.log(`Error parsing deployment profile plist file ${ inputPath }`, error);
    const msg = `Error loading plist file ${ inputPath }: ${ getErrorString(error) }`;

    throw new DeploymentProfileError(msg);
  }

  try {
    return JSON.parse(plutilResult.stdout ?? '');
  } catch (error: any) {
    console.log(`Error parsing deployment profile JSON object ${ inputPath }\n${ error }`);
    throw new DeploymentProfileError(`Error parsing deployment profile JSON object from ${ inputPath }: ${ getErrorString(error) }`);
  }
}

/**
 * Read and parse plutil deployment profile files.
 * @param rootPath the system or user directory containing profiles.
 * @param defaultsPath the file path to the 'defaults' file.
 * @param lockedPath the file path to the 'locked' file.
 * @returns the defaults and/or locked objects if they exist, or
 *          throws an exception if there is an error parsing the locked file.
 */

async function parseJsonFromPlists(rootPath: string, defaultsPath: string, lockedPath: string): Promise<(undefined | RecursivePartial<settings.Settings>)[]> {
  return [
    await convertAndParsePlist(join(rootPath, defaultsPath)),
    await convertAndParsePlist(join(rootPath, lockedPath)),
  ];
}

/**
 * Read and parse deployment profile files.
 * @param rootPath the system or user directory containing profiles.
 * @param defaultsPath the file path to the 'defaults' file.
 * @param lockedPath the file path to the 'locked' file.
 * @returns the defaults and/or locked objects if they exist, or
 *          throws an exception if there is an error parsing the locked file.
 */
function parseJsonFiles(rootPath: string, defaultsPath: string, lockedPath: string): (undefined | RecursivePartial<settings.Settings>)[] {
  return [defaultsPath, lockedPath].map((configPath) => {
    const fullPath = join(rootPath, configPath);

    try {
      return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch (ex: any) {
      if (ex.code !== 'ENOENT') {
        throw new DeploymentProfileError(`Error parsing deployment profile from ${ fullPath }: ${ ex }`);
      }
    }
  });
}

/**
 * Do simple type validation of a deployment profile
 * @param inputPath Used for error messages only
 * @param profile The profile to be validated
 * @param schema The structure (usually defaultSettings) used as a template
 * @param parentPathParts The parent path for the current schema key.
 * @returns The original profile, less any invalid fields
 */
export function validateDeploymentProfile(inputPath: string, profile: any, schema: any, parentPathParts: string[]): RecursivePartial<settings.Settings> {
  const errors: string[] = [];

  validateDeploymentProfileWithErrors(profile, errors, schema, parentPathParts);
  if (errors.length) {
    throw new DeploymentProfileError(`Error in deployment file ${ inputPath }:\n${ errors.join('\n') }`);
  }

  return profile;
}

/**
 * Do simple type validation of a deployment profile
 * @param profile The profile to be validated, modified in place
 * @param errors An array of error messages, built up in place
 * @param schema The structure (usually defaultSettings) used as a template
 * @param parentPathParts The parent path for the current schema key.
 * @returns The original profile, less any invalid fields
 */
function validateDeploymentProfileWithErrors(profile: any, errors: string[], schema: any, parentPathParts: string[]) {
  if (typeof profile !== 'object') {
    return profile;
  }
  const fullPath = (key: string) => {
    return [...parentPathParts, key].join('.');
  };

  for (const key in profile) {
    if (!(key in schema)) {
      console.log(`Deployment Profile ignoring '${ fullPath(key) }': not in schema.`);
      delete profile[key];
      continue;
    }
    const schemaVal = schema[key];
    const profileVal = profile[key];

    if (Array.isArray(profileVal) || Array.isArray(schemaVal)) {
      if (Array.isArray(profileVal) !== Array.isArray(schemaVal)) {
        if (Array.isArray(schemaVal)) {
          errors.push(`Error for field '${ fullPath(key) }': expecting value of type array, got '${ JSON.stringify(profileVal) }'`);
        } else {
          errors.push(`Error for field '${ fullPath(key) }': expecting value of type ${ typeof schemaVal }, got an array ${ JSON.stringify(profileVal) }`);
        }
      }
    } else if (typeof profileVal !== 'object') {
      if (typeof profileVal !== typeof schemaVal) {
        errors.push(`Error for field '${ fullPath(key) }': expecting value of type ${ typeof schemaVal }, got '${ JSON.stringify(profileVal) }'`);
      }
    } else if (haveUserDefinedObject(parentPathParts.concat(key))) {
      // Keep this part of the profile
    } else if (typeof profileVal !== typeof schemaVal) {
      errors.push(`Error for field '${ fullPath(key) }': expecting value of type ${ typeof schemaVal }, got '${ JSON.stringify(profileVal) }'`);
    } else {
      // Finally recurse and compare the schema sub-object with the specified sub-object
      validateDeploymentProfileWithErrors(profileVal, errors, schemaVal, [...parentPathParts, key]);
    }
  }

  return profile;
}

const userDefinedKeys = [
  'application.extensions.installed',
].map(s => s.split('.'));

/**
 * A "user-defined object" from the schema's point of view is an object that contains user-defined keys.
 * For example, `application.extensions.installed` points to a user-defined object.
 *
 * @param pathParts - The path-parts up to but not including the root (which is unnamed anyway).
 * @returns boolean
 */
function haveUserDefinedObject(pathParts: string[]): boolean {
  return userDefinedKeys.some(userDefinedKey => _.isEqual(userDefinedKey, pathParts));
}
