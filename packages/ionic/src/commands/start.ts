import * as fs from 'fs';
import * as path from 'path';

import * as chalk from 'chalk';

import {
  Command,
  CommandLineInputs,
  CommandLineOptions,
  CommandMetadata,
  CommandPreInputsPrompt,
  CommandPreRun,
  getCommandInfo,
  pathExists,
  pkgInstall,
  pkgInstallPlugin,
  prettyPath,
  rimrafp,
} from '@ionic/cli-utils';

import {
  isProjectNameValid,
  tarXvfFromUrl,
  isSafeToCreateProjectIn,
  getStarterTemplateTextList,
  getHelloText,
  patchPackageJsonForCli,
  updatePackageJsonForCli,
  createProjectConfig,
} from '../lib/start';

import { load } from '../lib/modules';
import { StarterTemplate } from '../definitions';
import { STARTER_TYPES, STARTER_TEMPLATES } from '../lib/starter-templates';

@CommandMetadata({
  name: 'start',
  type: 'global',
  description: 'Create a new project',
  exampleCommands: [
    '',
    'mynewapp blank',
    'mynewapp tabs --type ionic-angular',
    'mynewapp blank --type ionic1'
  ],
  inputs: [
    {
      name: 'name',
      description: 'The name of your project directory',
    },
    {
      name: 'template',
      description: `The starter template to use (e.g. ${['blank', 'tabs'].map(t => chalk.green(t)).join(', ')}; use ${chalk.green('--list')} to see all)`,
    }
  ],
  options: [
    {
      name: 'type',
      description: `Type of project to start (e.g. ${STARTER_TYPES.map(st => chalk.green(st.id)).join(', ')})`,
      type: String,
      default: 'ionic-angular',
    },
    {
      name: 'app-name',
      description: 'Human-readable name (use quotes around the name)',
      type: String,
      aliases: ['n'],
    },
    {
      name: 'list',
      description: 'List starter templates available',
      type: Boolean,
      aliases: ['l']
    },
    {
      name: 'skip-deps',
      description: 'Skip npm/yarn package installation of dependencies',
      type: Boolean,
    },
    {
      name: 'no-cordova',
      description: 'Skip automatic Cordova integration',
      type: Boolean,
    },
    {
      name: 'yarn',
      description: 'Opt-in to using yarn (instead of npm)',
      type: Boolean,
    },
    {
      name: 'skip-link',
      description: 'Do not link app to an Ionic Account',
      type: Boolean,
    },
  ]
})
export class StartCommand extends Command implements CommandPreRun, CommandPreInputsPrompt {
  async preInputsPrompt() {
    // If the action is list then lets just end here.
    if (this.env.argv['list']) {
      this.env.log.msg(getStarterTemplateTextList(STARTER_TEMPLATES).join('\n'));
      return 0;
    }

    if (this.env.project.directory) {
      const response = await this.env.prompt({
        type: 'confirm',
        name: 'continue',
        message: 'You are already in an Ionic project directory. Do you really want to start another project here?',
        default: false,
      });

      if (!response['continue']) {
        return 0;
      }
    }

  }

  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (options['v1'] || options['v2']) {
      const type = options['v1'] ? 'ionic1' : 'ionic-angular';

      throw this.exit(
        `Sorry! The ${chalk.green('--v1')} and ${chalk.green('--v2')} flags have been removed.\n` +
        `Use the ${chalk.green('--type')} option. (${chalk.green('ionic start --help')})\n\n` +
        `For ${chalk.bold(this.env.project.formatType(type))} projects, try ${chalk.green('ionic start ' + (inputs.length > 0 ? inputs.join(' ') + ' ' : '') + '--type ' + type)}`
      );
    }

    if (!inputs[0]) {
      const response = await this.env.prompt({
        name: 'name',
        message: 'What would you like to name your project:',
      });

      inputs[0] = response['name'];
    }

    if (!inputs[1]) {
      const response = await this.env.prompt({
        type: 'list',
        name: 'template',
        message: 'What starter would you like to use:',
        choices: () => {
          const starterTemplates = STARTER_TEMPLATES.filter(st => st.type === options['type']);

          return getStarterTemplateTextList(starterTemplates)
            .map((text: string, index: number) => {
              return {
                name: text,
                short: starterTemplates[index].name,
                value: starterTemplates[index].name
              };
            });
        }
      });

      inputs[1] = response['template'];
    }
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    let [ projectName, starterTemplateName ] = inputs;
    let appName = <string>options['app-name'] || projectName;
    let cloudAppId = <string>options['cloud-app-id'] || '';
    let starterBranchName = <string>options['starterBranchName'] || 'master';
    let wrapperBranchName = <string>options['wrapperBranchName'] || 'master';
    let projectRoot: string;

    if (!isProjectNameValid(projectName)) {
      throw `Please name your Ionic project something meaningful other than ${chalk.red(projectName)}`;
    }

    let starterType = STARTER_TYPES.find(type => type['id'] === options['type']);

    if (!starterType) {
      throw `Unable to find starter type for ${options['type']}`;
    }

    if (!options['skip-deps']) {
      // Check global dependencies
      const globalDeps = starterType.globalDependencies.filter(dep => {
        return dep !== 'cordova' || options['no-cordova'];
      });

      this.env.log.debug(`globalDeps=${globalDeps}`);

      for (let dep of globalDeps) {
        const cmdInstalled = await getCommandInfo(dep);

        if (typeof cmdInstalled === 'undefined') {
          if (dep === 'cordova') {
            throw this.exit(`Cordova CLI not found on your PATH. Please install Cordova globally (you may need ${chalk.green('sudo')}):\n\n` +
                            `${chalk.green('npm install -g cordova')}\n\n` +
                            `If that doesn't work, see the installation docs: https://cordova.apache.org/docs/en/latest/guide/cli/#installing-the-cordova-cli`);
          } else {
            throw this.exit(`Sorry, ${chalk.green(dep)} is a global dependency, but it was not found on your PATH.`);
          }
        }
      }
    }

    projectRoot = path.resolve(projectName);
    projectName = path.basename(projectRoot);

    const projectExists = await pathExists(projectName);

    // Create the project directory
    if (!projectExists) {
      this.env.tasks.next(`Creating directory ${chalk.green(prettyPath(projectRoot))}`);
      fs.mkdirSync(projectRoot);
    } else if (!isSafeToCreateProjectIn(projectRoot)) {
      const response = await this.env.prompt({
        type: 'confirm',
        name: 'overwrite',
        message: `The directory ${chalk.green(projectName)} contains file(s) that could conflict. ` +
            'Would you like to overwrite the directory with this new project?'
      });

      if (response['overwrite']) {
        try {
          this.env.tasks.next(`Creating directory ${chalk.green(prettyPath(projectRoot))}`);
          await rimrafp(projectRoot);
          fs.mkdirSync(projectRoot);
        } catch (e) {
          throw e;
        }
      } else {
        this.env.log.msg('\nPlease provide a projectName that does not conflict with this directory.\n\n');
        return 0;
      }
    }

    let starterTemplateMatches: StarterTemplate[] = STARTER_TEMPLATES.filter(t => t.type === options['type'] && t.name === starterTemplateName);
    let starterTemplate: StarterTemplate | undefined = starterTemplateMatches[0];

    if (starterTemplateMatches.length > 1) {
      starterTemplate = starterTemplateMatches.find(t => t.type === options['type']);
    }

    if (!starterTemplate) {
      throw `Unable to find starter template for ${starterTemplateName}`;
    }

    const wrapperBranchPath = starterType.baseArchive.replace('<BRANCH_NAME>', wrapperBranchName);
    const starterBranchPath = starterTemplate.archive.replace('<BRANCH_NAME>', starterBranchName);

    const extractDir = options['type'] === 'ionic1' ? path.join(projectRoot, 'www') : projectRoot;

    this.env.tasks.end();
    this.env.log.info(`Fetching app base (${chalk.dim(wrapperBranchPath)})`);
    const d1Task = this.env.tasks.next('Downloading');
    await tarXvfFromUrl(wrapperBranchPath, projectRoot, { progress: (loaded, total) => {
      d1Task.progress(loaded, total);
    }});

    this.env.tasks.end();
    this.env.log.info(`Fetching starter template ${chalk.bold(starterTemplateName.toString())} (${chalk.dim(starterBranchPath)})`);
    const d2Task = this.env.tasks.next('Downloading');
    await tarXvfFromUrl(starterBranchPath, extractDir, { progress: (loaded, total) => {
      d2Task.progress(loaded, total);
    }});

    if (options['type'] === 'ionic1') {
      const resourcesPath = 'https://github.com/driftyco/ionic-default-resources/archive/master.tar.gz';
      this.env.tasks.end();
      this.env.log.info(`Fetching resources (${chalk.dim(resourcesPath)})`);
      const d3Task = this.env.tasks.next('Downloading');
      await tarXvfFromUrl(resourcesPath, path.join(projectRoot, 'resources'), { progress: (loaded, total) => {
        d3Task.progress(loaded, total);
      }});
    }

    this.env.tasks.next(`Updating ${chalk.bold('package.json')} with app details`);

    await patchPackageJsonForCli(appName, starterType, projectRoot);
    await updatePackageJsonForCli(appName, starterType, projectRoot);

    this.env.tasks.next(`Creating configuration file ${chalk.bold('ionic.config.json')}`);
    await createProjectConfig(appName, starterType, projectRoot, cloudAppId);

    this.env.tasks.end();

    const config = await this.env.config.load();

    if (options['yarn']) {
      this.env.log.debug('Opting into yarn!');
      config.cliFlags.yarn = true;
    }

    if (!options['skip-deps']) {
      // Install local dependencies

      this.env.log.info('Installing dependencies may take several minutes!');
      const o = { cwd: projectRoot };

      await pkgInstall(this.env, undefined, o);

      const localDeps = starterType.localDependencies.filter(dep => {
        return dep !== '@ionic/cli-plugin-cordova' || options['no-cordova'];
      });

      this.env.log.debug(`localDeps=${localDeps}`);

      for (let dep of localDeps) {
        await pkgInstallPlugin(this.env, dep, o);
      }
    }

    // Print out hello text about how to get started
    this.env.log.msg(getHelloText());

    // Ask the user if they would like to create a cloud account
    if (!options['skip-link']) {
      const { linkApp } = await this.env.prompt({
        type: 'confirm',
        name: 'linkApp',
        message: 'Link this app to your Ionic Dashboard to use tools like Ionic View?'
      });

      if (linkApp && await this.env.session.isLoggedIn()) {
        const opn = load('opn');
        const token = await this.env.session.getUserToken();
        opn(`${config.urls.dash}/?user_token=${token}`, { wait: false });
        this.env.log.ok(`Run ${chalk.green(`ionic link`)} to link to the app.`);
      } else if (linkApp) {
        this.env.log.msg(`\nYou will need to login in order to link this app. Please run the following commands to do so.\n` +
          `  ${chalk.green(`ionic login`)} - login first\n` +
          `  ${chalk.green(`ionic link`)} - then link your app`);
      }
    }

    this.env.log.msg(`\nGo to your newly created project: ${chalk.green(`cd ${prettyPath(projectRoot)}`)}\n`);
  }
}
