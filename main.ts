import OGIAddon, { ConfigurationBuilder } from 'ogi-addon';
import { GenesisLib } from 'genesis-lib';
import fs from 'fs';
import { spawn, spawnSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const STEAM_TINKER_LAUNCH_PATH = '/home/' + process.env.USER + '/.local/share/OpenGameInstaller/bin/steamtinkerlaunch/steamtinkerlaunch';

// Cache for app IDs to avoid repeated lookups
const cachedAppIds: Map<string, number> = new Map();

function callSteamTinkerLaunch(...command: string[]): void {
  const result = spawnSync(STEAM_TINKER_LAUNCH_PATH, command, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`steamtinkerlaunch exited with code ${result.status}`);
  }
}

/**
 * Extract non-Steam game ID using steamtinkerlaunch getid command
 * @param gameName - The name of the game to look up
 * @param version - Optional version string to try versioned name first
 * @returns The app ID if found, null otherwise
 */
async function extractNonSteamGameId(gameName: string, version?: string): Promise<number | null> {
  // Try versioned name first if version is provided
  const namesToTry = version ? [`${gameName} (${version})`, gameName] : [gameName];

  for (const nameToTry of namesToTry) {
    // Check cache first
    if (cachedAppIds.has(nameToTry)) {
      return cachedAppIds.get(nameToTry)!;
    }

    try {
      // Call steamtinkerlaunch getid <gameName>
      const { stdout } = await execFileAsync(STEAM_TINKER_LAUNCH_PATH, ['getid', nameToTry]);
      
      // Parse stdout: Format is `<appid>\t(<game name>)` or `<appid> (<game name>)`
      // Find line containing `(<game name>)`
      const output = stdout.toString();
      const appIdLine = output.split('\n').find(line => line.includes('(' + nameToTry + ')'));
      
      if (appIdLine) {
        // Extract app ID: split on `(` and parse the leading number
        const appId = parseInt(appIdLine.split('(')[0].trim());
        
        if (!isNaN(appId)) {
          // Cache the result
          cachedAppIds.set(nameToTry, appId);
          return appId;
        }
      }
    } catch (error) {
      // Continue to next name if this one fails
      continue;
    }
  }

  return null;
}

const addon = new OGIAddon({
  name: 'Local Files',
  version: '1.0.0',
  id: 'local-files',

  author: 'OGI Addon Team',
  description: 'Your addon description',
  repository: 'Repository URL',
  storefronts: ['*'],
});

const lib = new GenesisLib({
  ogiAddon: addon,
  puppeteer: false
});

addon.on('configure', (config) => config);

addon.on('connect', lib.wrap('connect@HEAD', async () => {
  console.log('Local-Files: Connected to OGI');
}));

addon.on('search', (data, event) => {
  const { storefront, appID, for: forType } = data;
  if (forType === 'task' && (process.platform === 'linux' || process.platform === 'darwin')) {
    event.resolve([
      {
        downloadType: 'task',
        name: 'Open Winetricks',
        taskName: 'open-winetricks',
      }
    ])
    return;
  }
  event.resolve([
    {
      downloadType: 'empty',
      name: 'Local Files'
    }
  ])
});

addon.on('setup', lib.wrap('setup@HEAD', async ({ path, appID }, event) => {
  event.defer();
  const input = await event.askForInput(
    'Local Files Setup',
    'Please fill out the following information to add the game to OpenGameInstaller.',
    new ConfigurationBuilder()
      .addStringOption(option =>
        option
          .setName('workingDirectory')
          .setDescription('The working directory of the game.')
          .setDisplayName('Working Directory')
          .setInputType('folder')
      )
      .addStringOption(option =>
        option
          .setName('executable')
          .setDescription('The executable of the game.')
          .setDisplayName('Executable')
          .setInputType('file')
      )
      .addActionOption(option =>
        option
          .setName('exit')
          .setDescription('Exit the setup process.')
          .setDisplayName('Exit')
          .setButtonText('Exit')
      )
  )

  if (input.exit) {
    event.fail('User exited the setup process.');
    return;
  }

  const { workingDirectory, executable } = input;

  if (!workingDirectory || !executable) {
    event.fail('User did not fill out all the required information.');
    return;
  }

  // check if the working directory and executable exist
  if (!fs.existsSync(workingDirectory)) {
    event.fail('Working directory does not exist.');
    return;
  }
  if (!fs.existsSync(executable)) {
    event.fail('Executable does not exist.');
    return;
  }

  event.resolve({
    cwd: workingDirectory,
    launchExecutable: executable,
    version: 'localfiles-ver'
  });

}));

addon.onTask('open-winetricks', async (task, { libraryInfo }) => {
  addon.notify({
    id: 'open-winetricks',
    type: 'info',
    message: 'Open Winetricks',
  });

  const gameId = await extractNonSteamGameId(libraryInfo.name, libraryInfo.version);
  if (!gameId) {
    addon.notify({
      id: 'open-winetricks',
      type: 'error',
      message: 'Game ID not found.',
    });
    return;
  }

  const protonPath = `/home/${process.env.USER}/.local/share/Steam/steamapps/compatdata/${gameId}/pfx`;
  if (!fs.existsSync(protonPath)) {
    addon.notify({
      id: 'open-winetricks',
      type: 'error',
      message: 'Proton path not found.',
    });
    return;
  }

  addon.notify({
    id: 'open-winetricks',
    type: 'info',
    message: 'Opening Winetricks...',
  });
  const result = spawnSync('flatpak', ['run', 'org.winehq.Wine', '--command=winetricks'], {
    env: {
      'WINEPREFIX': protonPath
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    addon.notify({
      id: 'open-winetricks',
      type: 'error',
      message: 'Winetricks failed.',
    });
    return;
  }
  
  task.complete();
});

addon.on('disconnect', () => {
  process.exit(0);
});
