import { LOGGER_LEVELS, ParsedArgs, createPromptModule } from '@ionic/cli-framework';
import { TTY_WIDTH, prettyPath, wordWrap } from '@ionic/cli-framework/utils/format';
import { TERMINAL_INFO } from '@ionic/cli-framework/utils/terminal';
import { findBaseDirectory } from '@ionic/utils-fs';
import chalk from 'chalk';
import * as Debug from 'debug';
import * as path from 'path';

import { ERROR_VERSION_TOO_OLD } from '../bootstrap';
import { PROJECT_FILE, PROJECT_TYPES } from '../constants';
import { IProject, InfoItem, IonicContext, IonicEnvironment, IonicEnvironmentFlags } from '../definitions';

import { CONFIG_FILE, Config, DEFAULT_CONFIG_DIRECTORY, parseGlobalOptions } from './config';
import { Environment } from './environment';
import { Client } from './http';
import { ProjectDeps, ProjectDetails, createProjectFromType, prettyProjectName } from './project';
import { createOnFallback } from './prompts';
import { ProSession } from './session';
import { Shell, prependNodeModulesBinToPath } from './shell';
import { PROXY_ENVIRONMENT_VARIABLES } from './utils/http';
import { Logger, createDefaultLoggerHandlers } from './utils/logger';

const debug = Debug('ionic:lib');

export async function getProject(rootDirectory: string | undefined, args: ParsedArgs, deps: ProjectDeps): Promise<IProject | undefined> {
  if (!rootDirectory) {
    return;
  }

  const { log } = deps;
  const details = new ProjectDetails({ rootDirectory, args, e: deps });
  const { errors, ...result } = await details.result();
  const errorCodes = errors.map(e => e.code);
  debug('Project details: %o', { ...result, errorCodes });
  const { type } = result;

  const err = errors.find(e => e.code === 'ERR_INVALID_PROJECT_FILE');

  if (err) {
    log.error(
      `Error while loading project config file.\n` +
      `Attempted to load project config ${chalk.bold(prettyPath(result.configPath))} but got error:\n\n` +
      chalk.red(err.error ? err.error.toString() : 'ERR_INVALID_PROJECT_FILE')
    );

    log.nl();
  }

  if (result.context === 'multiapp') {
    if (errorCodes.includes('ERR_MULTI_MISSING_NAME')) {
      log.warn(
        `Multi-app workspace detected, but cannot determine which project to use.\n` +
        `Please set a ${chalk.green('defaultProject')} in ${chalk.bold(prettyPath(result.configPath))} or specify the project using the global ${chalk.green('--project')} option. Read the documentation${chalk.cyan('[1]')} for more information.\n\n` +
        `${chalk.cyan('[1]')}: ${chalk.bold('https://beta.ionicframework.com/docs/cli/configuration#multi-app-projects')}`
      );

      log.nl();
    }

    if (result.name && errorCodes.includes('ERR_MULTI_MISSING_CONFIG')) {
      log.warn(
        `Multi-app workspace detected, but project was not found in configuration.\n` +
        `Project ${chalk.green(result.name)} could not be found in the workspace. Did you add it to ${chalk.bold(prettyPath(result.configPath))}?`
      );
    }
  }

  if (errorCodes.includes('ERR_MISSING_PROJECT_TYPE')) {
    const listWrapOptions = { width: TTY_WIDTH - 8 - 3, indentation: 1 };

    log.warn(
      `Could not determine project type (project config: ${chalk.bold(prettyPath(result.configPath))}).\n` +
      `- ${wordWrap(`For ${chalk.bold(prettyProjectName('angular'))} projects, make sure ${chalk.green('@ionic/angular')} is listed as a dependency in ${chalk.bold('package.json')}.`, listWrapOptions)}\n` +
      `- ${wordWrap(`For ${chalk.bold(prettyProjectName('ionic-angular'))} projects, make sure ${chalk.green('ionic-angular')} is listed as a dependency in ${chalk.bold('package.json')}.`, listWrapOptions)}\n` +
      `- ${wordWrap(`For ${chalk.bold(prettyProjectName('ionic1'))} projects, make sure ${chalk.green('ionic')} is listed as a dependency in ${chalk.bold('bower.json')}.`, listWrapOptions)}\n\n` +
      `Alternatively, set ${chalk.bold('type')} attribute in ${chalk.bold(prettyPath(result.configPath))} to one of: ${PROJECT_TYPES.map(v => chalk.green(v)).join(', ')}.\n\n` +
      `If the Ionic CLI does not know what type of project this is, ${chalk.green('ionic build')}, ${chalk.green('ionic serve')}, and other commands may not work. You can use the ${chalk.green('custom')} project type if that's okay.`
    );

    log.nl();
  }

  if (!type) {
    return;
  }

  if (errorCodes.includes('ERR_INVALID_PROJECT_TYPE')) {
    log.error(
      `Invalid project type: ${chalk.green(type)} (project config: ${chalk.bold(prettyPath(result.configPath))}).\n` +
      `Project type must be one of: ${PROJECT_TYPES.map(v => chalk.green(v)).join(', ')}`
    );

    log.nl();
    return;
  }

  if (result.context === 'app') {
    return createProjectFromType(result.configPath, undefined, deps, type);
  } else if (result.context === 'multiapp') {
    return createProjectFromType(result.configPath, result.name, deps, type);
  }
}

export async function generateIonicEnvironment(ctx: IonicContext, pargv: string[]): Promise<{ env: IonicEnvironment; project?: IProject; }> {
  process.chdir(ctx.execPath);

  const argv = parseGlobalOptions(pargv);
  const config = new Config(path.resolve(process.env['IONIC_CONFIG_DIRECTORY'] || DEFAULT_CONFIG_DIRECTORY, CONFIG_FILE));

  debug('Terminal info: %o', TERMINAL_INFO);

  if (config.get('interactive') === false || !TERMINAL_INFO.tty || TERMINAL_INFO.ci) {
    argv['interactive'] = false;
  }

  const flags = argv as any as IonicEnvironmentFlags; // TODO
  debug('CLI global options: %o', flags);

  const log = new Logger({
    level: argv['quiet'] ? LOGGER_LEVELS.WARN : LOGGER_LEVELS.INFO,
    handlers: createDefaultLoggerHandlers(),
  });

  const prompt = await createPromptModule({
    interactive: argv['interactive'],
    onFallback: createOnFallback({ flags, log }),
  });

  const projectDir = await findBaseDirectory(ctx.execPath, PROJECT_FILE);
  const proxyVars = PROXY_ENVIRONMENT_VARIABLES.map((e): [string, string | undefined] => [e, process.env[e]]).filter(([, v]) => !!v);

  const getInfo = async () => {
    const osName = await import('os-name');
    const os = osName();

    const npm = await shell.cmdinfo('npm', ['-v']);

    const info: InfoItem[] = [
      {
        group: 'ionic',
        key: 'ionic',
        flair: 'Ionic CLI',
        value: ctx.version,
        path: ctx.libPath,
      },
      { group: 'system', key: 'NodeJS', value: process.version, path: process.execPath },
      { group: 'system', key: 'npm', value: npm || 'not installed' },
      { group: 'system', key: 'OS', value: os },
    ];

    info.push(...proxyVars.map(([e, v]): InfoItem => ({ group: 'environment', key: e, value: v || 'not set' })));

    if (project) {
      info.push(...(await project.getInfo()));
    }

    return info;
  };

  const shell = new Shell({ log }, { alterPath: p => projectDir ? prependNodeModulesBinToPath(projectDir, p) : p });
  const client = new Client(config);
  const session = new ProSession({ config, client });
  const deps = { client, config, ctx, flags, log, prompt, session, shell };
  const env = new Environment({ getInfo, ...deps });

  if (process.env['IONIC_CLI_LOCAL_ERROR']) {
    if (process.env['IONIC_CLI_LOCAL_ERROR'] === ERROR_VERSION_TOO_OLD) {
      log.warn(`Detected locally installed Ionic CLI, but it's too old--using global CLI.`);
    }
  }

  if (typeof argv['yarn'] === 'boolean') {
    log.warn(`${chalk.green('--yarn')} / ${chalk.green('--no-yarn')} has been removed. Use ${chalk.green(`ionic config set -g npmClient ${argv['yarn'] ? 'yarn' : 'npm'}`)}.`);
  }

  const project = await getProject(projectDir, argv, deps);

  if (project) {
    shell.alterPath = p => prependNodeModulesBinToPath(project.directory, p);
  }

  return { env, project };
}
