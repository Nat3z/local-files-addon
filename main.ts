import OGIAddon, { ConfigurationBuilder } from "ogi-addon";
import fs from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { dirname } from "path";
import os from "os";
import clipboard from "clipboardy";
import { encryptFile } from "./encrypt";

const VALID_REDISTRIBUTABLES = [
  "dotnet40",
  "dotnet48",
  "xna40",
  "vcrun2022",
] as const;
const SELECTED_REDISTRIBUTABLE_PREFIX = "✔︎ ";

type Redistributable = (typeof VALID_REDISTRIBUTABLES)[number];

function parseRedistributableChoice(choice: string): Redistributable | null {
  const name = choice.startsWith(SELECTED_REDISTRIBUTABLE_PREFIX)
    ? choice.slice(SELECTED_REDISTRIBUTABLE_PREFIX.length)
    : choice;
  return VALID_REDISTRIBUTABLES.find((candidate) => candidate === name) ?? null;
}

/** Supports log stems like `2026-04-22T19-14-33-512Z` and `2026-04-23T01_26_52.851Z` (UTC). */
function logFilenameToUtcDate(filename: string): Date | null {
  if (!filename.endsWith(".log")) return null;
  const stem = filename.slice(0, -".log".length);
  const m = stem.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[-_:](\d{2})[-_:](\d{2})[._-](\d{3})Z$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLogChoiceLabel(filename: string): string {
  const date = logFilenameToUtcDate(filename);
  if (!date) return filename;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: true,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

const UMU_RUN_PATH =
  "/home/" +
  process.env.USER +
  "/.local/share/OpenGameInstaller/bin/umu-run/umu-run";

const addon = new OGIAddon({
  name: "Local Files",
  version: "1.0.0",
  id: "local-files",

  author: "OGI Addon Team",
  description: "A local/network file game manager and maintenance tool.",
  repository: "Repository URL",
  storefronts: ["*"],
});

const publicKeyNames = fs
  .readdirSync(join(__dirname, "keys"))
  .filter((file) => file.endsWith(".public.pem"))
  .map((file) => file.slice(0, -".public.pem".length));

addon.on("configure", (config) =>
  config
    .addStringOption((option) =>
      option
        .setName("publicKeyName")
        .setDescription(
          "This is used to encrypt the logs before uploading them to the OGI team or another person for support to ensure others cannot read your logs except the intended recipient.",
        )
        .setDisplayName("Public Key")
        .setInputType("text")
        .setDefaultValue("ogi")
        .setAllowedValues(publicKeyNames),
    )
    .addActionOption((option) =>
      option
        .setName("logRunner")
        .setDescription("Upload and encrypt your logs for support.")
        .setDisplayName("Upload Logs")
        .setButtonText("Upload Logs")
        .setTaskName("upload-latest-log"),
    ),
);

addon.on("connect", async () => {
  console.log("Local-Files: Connected to OGI");
});

addon.on("search", (data, event) => {
  const { storefront, appID, for: forType } = data;
  console.log("Local-Files: Search", data);
  if (
    forType === "task" &&
    (process.platform === "linux" || process.platform === "darwin")
  ) {
    event.resolve([
      {
        downloadType: "task",
        name: "Open Winetricks",
        taskName: "open-winetricks",
      },
    ]);
    return;
  }
  event.resolve([
    {
      downloadType: "empty",
      name: "Local Files",
    },
  ]);
});

addon.on("setup", async ({ path, appID }, event) => {
  event.defer();
  const input = await event.askForInput(
    "Local Files Setup",
    "Please fill out the following information to add the game to OpenGameInstaller.",
    new ConfigurationBuilder()
      .addStringOption((option) =>
        option
          .setName("workingDirectory")
          .setDescription("The working directory of the game.")
          .setDisplayName("Working Directory")
          .setInputType("folder"),
      )
      .addStringOption((option) =>
        option
          .setName("executable")
          .setDescription("The executable of the game.")
          .setDisplayName("Executable")
          .setInputType("file"),
      )
      .addActionOption((option) =>
        option
          .setName("exit")
          .setDescription("Exit the setup process.")
          .setDisplayName("Exit")
          .setButtonText("Exit"),
      ),
  );

  if (input.exit) {
    event.fail("User exited the setup process.");
    return;
  }

  const { workingDirectory, executable } = input;

  if (!workingDirectory || !executable) {
    event.fail("User did not fill out all the required information.");
    return;
  }

  // check if the working directory and executable exist
  if (!fs.existsSync(workingDirectory)) {
    event.fail("Working directory does not exist.");
    return;
  }
  if (!fs.existsSync(executable)) {
    event.fail("Executable does not exist.");
    return;
  }

  const selectedRedistributables = new Set<Redistributable>();
  if (process.platform === "linux") {
    while (true) {
      const redistributableChoices = VALID_REDISTRIBUTABLES.map((name) =>
        selectedRedistributables.has(name)
          ? `${SELECTED_REDISTRIBUTABLE_PREFIX}${name}`
          : name,
      );
      const { redistSelected, isDone } = await event.askForInput(
        "Choose Winetricks Verbs",
        "Select a verb to toggle, or press Done to continue.",
        new ConfigurationBuilder()
          .addStringOption((option) =>
            option
              .setName("redistSelected")
              .setDisplayName("Verb")
              .setDescription("Choose a redistributable to toggle.")
              .setInputType("text")
              .setAllowedValues(redistributableChoices)
              .setDefaultValue(redistributableChoices[0]),
          )
          .addActionOption((option) =>
            option
              .setName("isDone")
              .setDisplayName("Done")
              .setDescription("Continue with the selected redistributables.")
              .setButtonText("Done"),
          ),
      );

      if (isDone) {
        const selection = VALID_REDISTRIBUTABLES.filter((name) =>
          selectedRedistributables.has(name),
        );
        const { ready } = await event.askForInput(
          "Confirm Redistributables",
          selection.length > 0
            ? `Install these Winetricks verbs: ${selection.join(", ")}`
            : "Continue without installing any Winetricks verbs?",
          new ConfigurationBuilder()
            .addActionOption((option) =>
              option
                .setName("ready")
                .setDisplayName("Confirm")
                .setDescription("Confirm the selected redistributables.")
                .setButtonText("Confirm"),
            )
            .addActionOption((option) =>
              option
                .setName("notReady")
                .setDisplayName("Go Back")
                .setDescription("Return to redistributable selection.")
                .setButtonText("Go Back"),
            ),
        );
        if (ready) break;
        continue;
      }

      const redistributable = parseRedistributableChoice(redistSelected);
      if (!redistributable) {
        event.fail("Invalid redistributable selected.");
        return;
      }
      if (selectedRedistributables.has(redistributable)) {
        selectedRedistributables.delete(redistributable);
      } else {
        selectedRedistributables.add(redistributable);
      }
    }
  }

  const redistributables = VALID_REDISTRIBUTABLES.filter((name) =>
    selectedRedistributables.has(name),
  );

  event.resolve({
    cwd: workingDirectory,
    launchExecutable: executable,
    ...(redistributables.length > 0 && {
      redistributables: redistributables.map((name) => ({
        name,
        path: "winetricks",
      })),
    }),
    version: "localfiles-ver",
  });
});

addon.onTask("open-winetricks", async (task, { libraryInfo }) => {
  addon.notify({
    id: "open-winetricks",
    type: "info",
    message: "Opening Winetricks",
  });

  const protonPath = `${libraryInfo.umu?.winePrefixPath}`;
  if (!fs.existsSync(protonPath)) {
    addon.notify({
      id: "open-winetricks",
      type: "error",
      message: "Proton path not found.",
    });
    return;
  }

  addon.notify({
    id: "open-winetricks",
    type: "info",
    message: "Opening Winetricks...",
  });
  const result = spawnSync(UMU_RUN_PATH, ["winetricks", "--gui"], {
    env: {
      WINEPREFIX: protonPath,
      ...process.env,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    addon.notify({
      id: "open-winetricks",
      type: "error",
      message: "Winetricks failed.",
    });
    return;
  }

  task.complete();
});

addon.onTask("upload-latest-log", async (task) => {
  let updateDirectory: string;
  let logFolder: string;

  if (process.platform === "linux") {
    const input = await task.askForInput(
      "",
      "Where is your OpenGameInstaller-Setup.AppImage located?",
      new ConfigurationBuilder()
        .addActionOption((option) =>
          option
            .setName("exit")
            .setDescription("Exit the setup process.")
            .setDisplayName("Exit")
            .setButtonText("Exit"),
        )
        .addStringOption((option) =>
          option
            .setName("appImage")
            .setDescription("The path to your OpenGameInstaller-Setup.AppImage")
            .setDisplayName("OpenGameInstaller-Setup.AppImage")
            .setInputType("file"),
        ),
    );
    if (input.exit) {
      task.fail("Exited the upload process.");
      return;
    }
    updateDirectory = join(dirname(input.appImage), "update");
    logFolder = join(updateDirectory, "logs");
  } else {
    const input = await task.askForInput(
      " ",
      "Select your OpenGameInstaller update folder (the folder that contains the `logs` directory and `latest.log`).",
      new ConfigurationBuilder()
        .addActionOption((option) =>
          option
            .setName("exit")
            .setDescription("Exit the setup process.")
            .setDisplayName("Exit")
            .setButtonText("Exit"),
        )
        .addStringOption((option) =>
          option
            .setName("updateDirectory")
            .setDescription("Path to the OpenGameInstaller update directory")
            .setDisplayName("Update directory")
            .setInputType("folder"),
        ),
    );
    if (input.exit) {
      task.fail("Exited the upload process.");
      return;
    }
    updateDirectory = input.updateDirectory;
    logFolder = join(updateDirectory, "logs");
  }

  if (!fs.existsSync(logFolder)) {
    task.fail("Log folder does not exist.");
    return;
  }

  const logs = fs.readdirSync(logFolder).sort((a, b) => {
    const da = logFilenameToUtcDate(a)?.getTime() ?? 0;
    const db = logFilenameToUtcDate(b)?.getTime() ?? 0;
    if (da !== db) return db - da;
    return b.localeCompare(a);
  });
  const logChoiceLabelToFile = new Map<string, string>();
  const logsReadable: string[] = ["Latest Log"];
  for (const log of logs) {
    let label = formatLogChoiceLabel(log);
    if (logChoiceLabelToFile.has(label)) {
      label = `${label} (${log})`;
    }
    logChoiceLabelToFile.set(label, log);
    logsReadable.push(label);
  }

  let logsToUpload: string[] = [];
  while (true) {
    const input = await task.askForInput(
      "Which logs to upload?",
      "Please select the logs to upload. Add a log by selecting it below and pressing submit. When you are done, press continue to start the upload.",
      new ConfigurationBuilder()
        .addStringOption((option) =>
          option
            .setName("log")
            .setDescription("The log to upload")
            .setDisplayName("Log")
            .setInputType("text")
            .setAllowedValues(
              logsReadable.map((log) =>
                logsToUpload.find(
                  (l) =>
                    l ===
                      join(logFolder, logChoiceLabelToFile.get(log) ?? log) ||
                    (l.includes(join(updateDirectory, "latest.log")) &&
                      log === "Latest Log"),
                )
                  ? `✔︎ ${log}`
                  : log,
              ),
            ),
        )
        .addActionOption((option) =>
          option
            .setName("exit")
            .setDescription("Exit the upload process.")
            .setDisplayName("Exit")
            .setButtonText("Exit"),
        )
        .addActionOption((option) =>
          option
            .setName("continue")
            .setDescription("Continue the upload process.")
            .setDisplayName("Continue")
            .setButtonText("Continue To Upload"),
        ),
    );
    if (input.exit) {
      task.fail("Exited the upload process.");
      return;
    }
    if (!input.continue) {
      if (input.log.startsWith("✔︎ ")) {
        // remove the log file from the list
        // check if its a latest log with a checkmark and also remove the checkmark
        const unmarkedLabel = input.log.slice("✔︎ ".length);
        if (unmarkedLabel === "Latest Log") {
          logsToUpload = logsToUpload.filter(
            (log) => log !== join(updateDirectory, "latest.log"),
          );
        } else {
          const logFile = logChoiceLabelToFile.get(unmarkedLabel);
          if (logFile) {
            logsToUpload = logsToUpload.filter(
              (log) => log !== join(logFolder, logFile),
            );
          }
        }
      } else if (input.log === "Latest Log") {
        logsToUpload.push(join(updateDirectory, "latest.log"));
      } else if (!input.log.startsWith("✔︎ ")) {
        const file = logChoiceLabelToFile.get(input.log) ?? input.log;
        if (fs.existsSync(join(logFolder, file))) {
          logsToUpload.push(join(logFolder, file));
        }
      }
    }
    console.log("logsToUpload", logsToUpload);
    if (input.continue) break;
  }

  if (logsToUpload.length === 0) {
    task.fail("No logs to upload.");
    return;
  }

  let fileContent = ``;
  for (const log of logsToUpload) {
    const content = fs.readFileSync(log, "utf8");
    fileContent += [
      `--------------------------------------------------------`,
      `- ${formatLogChoiceLabel(log)}                                               `,
      `--------------------------------------------------------`,
      content,
      "",
    ].join("\n");
  }

  const tempFile = join(os.tmpdir(), "ogi-joined-log-upload.txt");

  const encryptedFile = await encryptFile(
    fileContent,
    addon.config.getStringValue("publicKeyName") ?? "ogi",
  );
  fs.writeFileSync(tempFile, encryptedFile, "utf8");

  const formData = new FormData();
  formData.append("file", Bun.file(tempFile));

  const result = await fetch("https://paste.rs", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data",
    },
    body: formData,
  });
  if (!result.ok) {
    task.fail("Failed to upload logs.");
    return;
  }
  const url = await result.text();
  const { copyURL } = await task.askForInput(
    "Logs uploaded successfully!",
    "The logs have been uploaded successfully. You can now share the following URL with the OGI team to help them diagnose the issue:",
    new ConfigurationBuilder()
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription(
            "The URL of the uploaded logs. You can copy and paste this URL into your browser to view the logs.",
          )
          .setDisplayName("URL")
          .setInputType("text")
          .setDefaultValue(url),
      )
      .addActionOption((option) =>
        option
          .setName("copyURL")
          .setDescription("Copy the URL to the clipboard.")
          .setDisplayName("Copy URL")
          .setButtonText("Copy URL"),
      ),
  );

  if (copyURL) {
    await clipboard.write(url);
    addon.notify({
      id: "upload-latest-log",
      type: "info",
      message:
        "URL copied to clipboard. Share this URL with the OGI team to help them diagnose the issue.",
    });
  }

  task.complete();
});

addon.on("disconnect", () => {
  process.exit(0);
});
