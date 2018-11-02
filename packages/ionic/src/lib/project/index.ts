import { BaseConfig, BaseConfigOptions, ParsedArgs, PromptModule } from '@ionic/cli-framework';
import { resolveValue } from '@ionic/cli-framework/utils/fn';
import { prettyPath } from '@ionic/cli-framework/utils/format';
import { ERROR_INVALID_PACKAGE_JSON, compileNodeModulesPaths, readPackageJsonFile, resolve } from '@ionic/cli-framework/utils/node';
import { readJsonFile, writeJsonFile } from '@ionic/utils-fs';
import chalk from 'chalk';
import * as Debug from 'debug';
import * as lodash from 'lodash';
import * as path from 'path';

import { PROJECT_FILE, PROJECT_TYPES } from '../../constants';
import { IAilmentRegistry, IClient, IConfig, IIntegration, ILogger, IMultiProjectConfig, IProject, IProjectConfig, ISession, IShell, InfoItem, IntegrationName, IonicContext, IonicEnvironmentFlags, PackageJson, ProjectIntegration, ProjectPersonalizationDetails, ProjectType } from '../../definitions';
import { isMultiProjectConfig, isProjectConfig } from '../../guards';
import * as ζbuild from '../build';
import { BaseException, FatalException, IntegrationNotFoundException, RunnerNotFoundException } from '../errors';
import * as ζgenerate from '../generate';
import { BaseIntegration } from '../integrations';
import * as ζserve from '../serve';

const debug = Debug('ionic:lib:project');

export interface ProjectDetailsDeps {
  readonly rootDirectory: string;
  readonly config?: { [key: string]: any; };
  readonly args?: ParsedArgs;
  readonly e: ProjectDeps;
}

export interface ProjectDetailsResultBase {
  readonly type?: ProjectType;
  readonly errors: ReadonlyArray<ProjectDetailsError>;
}

export interface ProjectDetailsSingleAppResult extends ProjectDetailsResultBase {
  readonly context: 'app';
  readonly config: Readonly<IProjectConfig>;
}

export interface ProjectDetailsMultiAppResult extends ProjectDetailsResultBase {
  readonly context: 'multiapp';
  readonly config: Readonly<IMultiProjectConfig>;
  readonly name?: string;
}

export interface ProjectDetailsUnknownResult extends ProjectDetailsResultBase {
  readonly context: 'unknown';
  readonly config?: unknown;
}

export type ProjectDetailsResult = (ProjectDetailsSingleAppResult | ProjectDetailsMultiAppResult | ProjectDetailsUnknownResult) & { readonly configPath: string; };

export type ProjectDetailsErrorCode = 'ERR_INVALID_PROJECT_FILE' | 'ERR_INVALID_PROJECT_TYPE' | 'ERR_MISSING_PROJECT_TYPE' | 'ERR_MULTI_MISSING_CONFIG' | 'ERR_MULTI_MISSING_NAME';

export class ProjectDetailsError extends BaseException {
  constructor(msg: string, readonly code: ProjectDetailsErrorCode, readonly error?: Error) {
    super(msg);
  }
}

export class ProjectDetails {
  readonly rootDirectory: string;

  protected readonly args?: ParsedArgs;
  protected readonly e: ProjectDeps;
  protected _result?: ProjectDetailsResult;
  protected _errors?: ProjectDetailsError[];

  constructor({ rootDirectory, args, e }: ProjectDetailsDeps) {
    this.rootDirectory = rootDirectory;
    this.args = args;
    this.e = e;
  }

  async result(): Promise<ProjectDetailsResult> {
    if (!this._result) {
      this._result = await this.determine();
    }

    return this._result;
  }

  protected async getNameFromArgs(): Promise<string | undefined> {
    const name = this.args && this.args['project'] ? String(this.args['project']) : undefined;

    if (name) {
      debug(`Project name from args: ${chalk.bold(name)}`);
      return name;
    }
  }

  protected async getNameFromPathMatch(config: IMultiProjectConfig): Promise<string | undefined> {
    const { ctx } = this.e;

    for (const [ key, value ] of lodash.entries(config.projects)) {
      const name = key;

      if (value && value.root) {
        const projectDir = path.resolve(this.rootDirectory, value.root);

        if (ctx.execPath.startsWith(projectDir)) {
          debug(`Project name from path match: ${chalk.bold(name)}`);
          return name;
        }
      }
    }
  }

  protected async getNameFromDefaultProject(config: IMultiProjectConfig): Promise<string | undefined> {
    const name = config.defaultProject;

    if (name) {
      debug(`Project name from defaultProject: ${chalk.bold(name)}`);
      return name;
    }
  }

  protected async getTypeFromConfig(config: IProjectConfig): Promise<ProjectType | undefined> {
    const { type } = config;

    if (type) {
      debug(`Project type from config: ${chalk.bold(prettyProjectName(type))} ${type ? chalk.bold(`(${type})`) : ''}`);
      return type;
    }
  }

  protected async getTypeFromDetection(): Promise<ProjectType | undefined> {
    for (const projectType of PROJECT_TYPES) {
      const p = await createProjectFromType(path.resolve(this.rootDirectory, PROJECT_FILE), undefined, this.e, projectType);
      const type = p.type;

      if (await p.detected()) {
        debug(`Project type from detection: ${chalk.bold(prettyProjectName(type))} ${type ? chalk.bold(`(${type})`) : ''}`);
        return type;
      }
    }
  }

  protected async determineSingleApp(config: IProjectConfig): Promise<ProjectDetailsSingleAppResult> {
    const errors: ProjectDetailsError[] = [];
    const type = await resolveValue(
      async () => this.getTypeFromConfig(config),
      async () => this.getTypeFromDetection()
    );

    if (!type) {
      errors.push(new ProjectDetailsError('Could not determine project type.', 'ERR_MISSING_PROJECT_TYPE'));
    } else if (!PROJECT_TYPES.includes(type)) {
      errors.push(new ProjectDetailsError('Invalid project type.', 'ERR_INVALID_PROJECT_TYPE'));
    }

    return { context: 'app', config, type, errors };
  }

  protected async determineMultiApp(config: IMultiProjectConfig): Promise<ProjectDetailsMultiAppResult> {
    const errors: ProjectDetailsError[] = [];
    const name = await resolveValue(
      async () => this.getNameFromArgs(),
      async () => this.getNameFromPathMatch(config),
      async () => this.getNameFromDefaultProject(config)
    );

    let type: ProjectType | undefined;

    if (name) {
      const app = config.projects[name];

      if (app) {
        const result = await this.determineSingleApp(app);
        type = result.type;
        errors.push(...result.errors);
      } else {
        errors.push(new ProjectDetailsError('Could not find project in config.', 'ERR_MULTI_MISSING_CONFIG'));
      }
    } else {
      errors.push(new ProjectDetailsError('Could not determine project name.', 'ERR_MULTI_MISSING_NAME'));
    }

    return { context: 'multiapp', config, name, type, errors };
  }

  protected async determine(): Promise<ProjectDetailsResult> {
    const errors: ProjectDetailsError[] = [];
    const configPath = path.resolve(this.rootDirectory, PROJECT_FILE);
    let config: { [key: string]: any; } | undefined;

    try {
      config = await readJsonFile(configPath);
    } catch (e) {
      errors.push(new ProjectDetailsError('Could not read project file.', 'ERR_INVALID_PROJECT_FILE', e));
    }

    if (config) {
      if (isProjectConfig(config)) {
        const result = await this.determineSingleApp(config);
        errors.push(...result.errors);
        return { configPath, errors, ...result };
      }

      if (isMultiProjectConfig(config)) {
        const result = await this.determineMultiApp(config);
        errors.push(...result.errors);
        return { configPath, errors, ...result };
      }
    }

    return { configPath, context: 'unknown', config, errors };
  }
}

export async function createProjectFromType(filePath: string, name: string | undefined, deps: ProjectDeps, type: ProjectType): Promise<IProject> {
  let project: IProject | undefined;

  if (type === 'angular') {
    const { AngularProject } = await import('./angular');
    project = new AngularProject(filePath, name, deps);
  } else if (type === 'ionic-angular') {
    const { IonicAngularProject } = await import('./ionic-angular');
    project = new IonicAngularProject(filePath, name, deps);
  } else if (type === 'ionic1') {
    const { Ionic1Project } = await import('./ionic1');
    project = new Ionic1Project(filePath, name, deps);
  } else if (type === 'custom') {
    const { CustomProject } = await import('./custom');
    project = new CustomProject(filePath, name, deps);
  } else {
    throw new FatalException(`Bad project type: ${chalk.bold(type)}`); // TODO?
  }

  return project;
}

export class ProjectConfig extends BaseConfig<IProjectConfig> {
  constructor(p: string, options?: BaseConfigOptions) {
    super(p, options);

    const c = this.c as any;

    // <4.0.0 project config migration
    if (typeof c.app_id === 'string') {
      if (c.app_id) {
        this.set('pro_id', c.app_id);
      }

      this.unset('app_id' as any);
    }
  }

  provideDefaults(): IProjectConfig {
    return {
      name: 'New Ionic App',
      integrations: {},
    };
  }
}

export interface ProjectDeps {
  readonly client: IClient;
  readonly config: IConfig;
  readonly flags: IonicEnvironmentFlags;
  readonly log: ILogger;
  readonly prompt: PromptModule;
  readonly session: ISession;
  readonly shell: IShell;
  readonly ctx: IonicContext;
}

export abstract class Project implements IProject {
  readonly rootDirectory: string;
  abstract readonly type: ProjectType;
  protected originalConfigFile?: { [key: string]: any };

  constructor(
    /**
     * The file path to the configuration file.
     */
    readonly filePath: string,

    /**
     * If provided, this is a multi-app project and will be configured to use
     * the app identified by this string. Otherwise, this is a single-app
     * project.
     */
    readonly name: string | undefined,

    protected readonly e: ProjectDeps
  ) {
    this.rootDirectory = path.dirname(filePath);
  }

  get directory(): string {
    const root = this.config.get('root');

    if (!root) {
      return this.rootDirectory;
    }

    return path.resolve(this.rootDirectory, root);
  }

  get config(): ProjectConfig {
    const options = typeof this.name === 'undefined'
      ? {}
      : { pathPrefix: ['projects', this.name] };

    return new ProjectConfig(this.filePath, options);
  }

  abstract detected(): Promise<boolean>;

  abstract requireBuildRunner(): Promise<ζbuild.BuildRunner<any>>;
  abstract requireServeRunner(): Promise<ζserve.ServeRunner<any>>;
  abstract requireGenerateRunner(): Promise<ζgenerate.GenerateRunner<any>>;

  async getBuildRunner(): Promise<ζbuild.BuildRunner<any> | undefined> {
    try {
      return await this.requireBuildRunner();
    } catch (e) {
      if (!(e instanceof RunnerNotFoundException)) {
        throw e;
      }
    }
  }

  async getServeRunner(): Promise<ζserve.ServeRunner<any> | undefined> {
    try {
      return await this.requireServeRunner();
    } catch (e) {
      if (!(e instanceof RunnerNotFoundException)) {
        throw e;
      }
    }
  }

  async getGenerateRunner(): Promise<ζgenerate.GenerateRunner<any> | undefined> {
    try {
      return await this.requireGenerateRunner();
    } catch (e) {
      if (!(e instanceof RunnerNotFoundException)) {
        throw e;
      }
    }
  }

  async requireProId(): Promise<string> {
    const proId = this.config.get('pro_id');

    if (!proId) {
      throw new FatalException(
        `Your project file (${chalk.bold(prettyPath(this.filePath))}) does not contain '${chalk.bold('pro_id')}'. ` +
        `Run ${chalk.green('ionic link')}.`
      );
    }

    return proId;
  }

  get packageJsonPath() {
    return path.resolve(this.directory, 'package.json');
  }

  async getPackageJson(pkgName?: string): Promise<[PackageJson | undefined, string | undefined]> {
    let pkg: PackageJson | undefined;
    let pkgPath: string | undefined;

    try {
      pkgPath = pkgName ? resolve(`${pkgName}/package`, { paths: compileNodeModulesPaths(this.directory) }) : this.packageJsonPath;
      pkg = await readPackageJsonFile(pkgPath);
    } catch (e) {
      this.e.log.error(`Error loading ${chalk.bold(pkgName ? pkgName : `project's`)} ${chalk.bold('package.json')}: ${e}`);
    }

    return [pkg, pkgPath ? path.dirname(pkgPath) : undefined];
  }

  async requirePackageJson(pkgName?: string): Promise<PackageJson> {
    try {
      const pkgPath = pkgName ? resolve(`${pkgName}/package`, { paths: compileNodeModulesPaths(this.directory) }) : this.packageJsonPath;
      return await readPackageJsonFile(pkgPath);
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new FatalException(`Could not parse ${chalk.bold(pkgName ? pkgName : `project's`)} ${chalk.bold('package.json')}. Is it a valid JSON file?`);
      } else if (e === ERROR_INVALID_PACKAGE_JSON) {
        throw new FatalException(`The ${chalk.bold(pkgName ? pkgName : `project's`)} ${chalk.bold('package.json')} file seems malformed.`);
      }

      throw e; // Probably file not found
    }
  }

  async getDocsUrl(): Promise<string> {
    return 'https://ionicframework.com/docs';
  }

  async getSourceDir(): Promise<string> {
    return path.resolve(this.directory, 'src');
  }

  async getDistDir(): Promise<string> {
    return path.resolve(this.directory, 'www');
  }

  async getInfo(): Promise<InfoItem[]> {
    const integrations = await this.getIntegrations();
    const integrationInfo = lodash.flatten(await Promise.all(integrations.map(async i => i.getInfo())));

    return integrationInfo;
  }

  async personalize(details: ProjectPersonalizationDetails): Promise<void> {
    const { name, projectId, description, version } = details;

    this.config.set('name', name);

    const pkg = await this.requirePackageJson();

    pkg.name = projectId;
    pkg.version = version ? version : '0.0.1';
    pkg.description = description ? description : 'An Ionic project';

    await writeJsonFile(this.packageJsonPath, pkg, { encoding: 'utf8' });

    const integrations = await this.getIntegrations();

    await Promise.all(integrations.map(async i => i.personalize(details)));
  }

  async registerAilments(registry: IAilmentRegistry): Promise<void> {
    const ailments = await import('../doctor/ailments');
    const deps = { ...this.e, project: this };

    registry.register(new ailments.NpmInstalledLocally(deps));
    registry.register(new ailments.IonicCLIInstalledLocally(deps));
    registry.register(new ailments.GitNotUsed(deps));
    registry.register(new ailments.GitConfigInvalid(deps));
    registry.register(new ailments.IonicNativeOldVersionInstalled(deps));
    registry.register(new ailments.UnsavedCordovaPlatforms(deps));
    registry.register(new ailments.DefaultCordovaBundleIdUsed(deps));
    registry.register(new ailments.ViewportFitNotSet(deps));
    registry.register(new ailments.CordovaPlatformsCommitted(deps));
  }

  async createIntegration(name: IntegrationName): Promise<IIntegration> {
    return BaseIntegration.createFromName({
      config: this.e.config,
      project: this,
      shell: this.e.shell,
      log: this.e.log,
    }, name);
  }

  getIntegration(name: IntegrationName): Required<ProjectIntegration> | undefined {
    const integration = this.config.get('integrations')[name];

    if (integration) {
      return {
        enabled: integration.enabled !== false,
        root: integration.root === undefined ? this.directory : path.resolve(this.rootDirectory, integration.root),
      };
    }
  }

  requireIntegration(name: IntegrationName): Required<ProjectIntegration> {
    const integration = this.getIntegration(name);

    if (!integration) {
      throw new FatalException(`Could not find ${chalk.bold(name)} integration in the ${chalk.bold(this.name ? this.name : 'default')} project.`);
    }

    if (!integration.enabled) {
      throw new FatalException(`${chalk.bold(name)} integration is disabled in the ${chalk.bold(this.name ? this.name : 'default')} project.`);
    }

    return integration;
  }

  protected async getIntegrations(): Promise<IIntegration[]> {
    const integrationsFromConfig = this.config.get('integrations');
    const names = Object.keys(integrationsFromConfig) as IntegrationName[]; // TODO

    const integrationNames = names.filter(n => {
      const c = integrationsFromConfig[n];
      return c && c.enabled !== false;
    });

    const integrations: (IIntegration | undefined)[] = await Promise.all(integrationNames.map(async name => {
      try {
        return await this.createIntegration(name);
      } catch (e) {
        if (!(e instanceof IntegrationNotFoundException)) {
          throw e;
        }

        this.e.log.warn(e.message);
      }
    }));

    return integrations.filter((i): i is IIntegration => typeof i !== 'undefined');
  }
}

export function prettyProjectName(type?: string): string {
  if (!type) {
    return 'Unknown';
  }

  if (type === 'angular') {
    return '@ionic/angular';
  } else if (type === 'ionic-angular') {
    return 'Ionic 2/3';
  } else if (type === 'ionic1') {
    return 'Ionic 1';
  }

  return type;
}

export function prettyProjectTooling(type?: string): string {
  if (type === 'angular') {
    return 'Angular 6+, Angular CLI';
  } else if (type === 'ionic-angular') {
    return 'Angular 5, @ionic/app-scripts';
  } else if (type === 'ionic1') {
    return 'AngularJS, gulp, sass';
  }

  return 'unknown tooling';
}
