import express, { Router } from 'express';
import compression from 'compression';

import {
  Builder,
  CoreConfig,
  normalizeStories,
  Options,
  StorybookConfig,
  logConfig,
} from '@storybook/core-common';

import { STORY_INDEX_INVALIDATED } from '@storybook/core-events';
import { debounce } from 'lodash';
import { telemetry } from '@storybook/telemetry';
import type { StoryIndex } from '@storybook/store';
import { getMiddleware } from './utils/middleware';
import { getServerAddresses } from './utils/server-address';
import { getServer } from './utils/server-init';
import { useStatics } from './utils/server-statics';
import { useStoriesJson, useStoriesJsonOld } from './utils/stories-json';
import { useStorybookMetadata } from './utils/metadata';
import { getServerChannel } from './utils/get-server-channel';

import { openInBrowser } from './utils/open-in-browser';
import { getPreviewBuilder } from './utils/get-preview-builder';
import { getManagerBuilder } from './utils/get-manager-builder';
import { getStoryIndexGenerator } from './utils/stories-index';
import { watchStorySpecifiers } from './utils/watch-story-specifiers';

// @ts-ignore
export const router: Router = new Router();

export const DEBOUNCE = 100;

export async function storybookDevServer(options: Options) {
  const startTime = process.hrtime();
  const app = express();
  const server = await getServer(app, options);
  const serverChannel = getServerChannel(server);

  const features = await options.presets.apply<StorybookConfig['features']>('features');
  // try get index generator, if failed, send telemetry without storyCount, then rethrow the error
  let storyIndex: StoryIndex;
  if (features?.buildStoriesJson || features?.storyStoreV7) {
    try {
      const workingDir = process.cwd();
      const normalizedStories = normalizeStories(await options.presets.apply('stories'), {
        configDir: options.configDir,
        workingDir,
      });
      const storyIndexGenerator = await getStoryIndexGenerator({
        configDir: options.configDir,
        workingDir,
        features,
        normalizedStories,
      });

      const maybeInvalidate = debounce(
        () => serverChannel.emit(STORY_INDEX_INVALIDATED),
        DEBOUNCE,
        {
          leading: true,
        }
      );
      watchStorySpecifiers(normalizedStories, { workingDir }, async (specifier, path, removed) => {
        storyIndexGenerator.invalidate(specifier, path, removed);
        maybeInvalidate();
      });

      storyIndex = await storyIndexGenerator.getIndex();
      await useStoriesJson(router, storyIndexGenerator);
    } catch (err) {
      telemetry('start', {});
      throw err;
    }
  }

  const core = await options.presets.apply<CoreConfig>('core');
  if (!core?.disableTelemetry) {
    const payload = storyIndex
      ? {
          storyIndex: {
            storyCount: Object.keys(storyIndex.stories).length,
            version: storyIndex.v,
          },
        }
      : undefined;
    telemetry('start', payload);
  }

  if (!core?.disableTelemetry) {
    await useStorybookMetadata(router);
  }

  app.use(compression({ level: 1 }));

  if (typeof options.extendServer === 'function') {
    options.extendServer(server);
  }

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // User's own static files
  await useStatics(router, options);

  getMiddleware(options.configDir)(router);
  app.use(router);

  const { port, host } = options;
  const proto = options.https ? 'https' : 'http';
  const { address, networkAddress } = getServerAddresses(port, host, proto);

  await new Promise<void>((resolve, reject) => {
    // FIXME: Following line doesn't match TypeScript signature at all 🤔
    // @ts-ignore
    server.listen({ port, host }, (error: Error) => (error ? reject(error) : resolve()));
  });

  const previewBuilder: Builder<unknown, unknown> = await getPreviewBuilder(options.configDir);
  const managerBuilder: Builder<unknown, unknown> = await getManagerBuilder(options.configDir);

  if (options.debugWebpack) {
    logConfig('Preview webpack config', await previewBuilder.getConfig(options));
    logConfig('Manager webpack config', await managerBuilder.getConfig(options));
  }

  const preview = options.ignorePreview
    ? Promise.resolve()
    : previewBuilder.start({
        startTime,
        options,
        router,
        server,
      });

  const manager = managerBuilder.start({
    startTime,
    options,
    router,
    server,
  });

  const [previewResult, managerResult] = await Promise.all([
    preview,
    manager
      // TODO #13083 Restore this when compiling the preview is fast enough
      // .then((result) => {
      //   if (!options.ci && !options.smokeTest) openInBrowser(address);
      //   return result;
      // })
      .catch(previewBuilder.bail),
  ]);

  // TODO #13083 Remove this when compiling the preview is fast enough
  if (!options.ci && !options.smokeTest && options.open) {
    openInBrowser(host ? networkAddress : address);
  }

  return { previewResult, managerResult, address, networkAddress };
}
