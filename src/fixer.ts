"use strict";

import * as spawn from "cross-spawn";
import { Configuration } from "./configuration";
import { Settings } from "./settings";
import { StandardsPathResolver } from "./resolvers/standards-path-resolver";
import { ConsoleError } from "./console-error";
import { window, TextDocument, Range, Position, TextEdit, ProviderResult, Disposable, workspace, ConfigurationChangeEvent } from "vscode";
export class Fixer {
    public config!: Settings;

    constructor(subscriptions: Disposable[], config: Settings) {
        this.config = config;
        workspace.onDidChangeConfiguration(this.loadSettings, this, subscriptions);
    }
    /**
     * Load Configuration from editor
     */
    public async loadSettings(event: ConfigurationChangeEvent) {
        if (!event.affectsConfiguration('phpsab') && !event.affectsConfiguration('editor.formatOnSaveTimeout')) {
            return;
        }
        let configuration = new Configuration();
        let config = await configuration.load();
        this.config = config;
    }

    /**
     * Build the arguments needed to execute fixer
     * @param fileName
     * @param standard
     */
    private getArgs(document: TextDocument, standard: string) {
        // Process linting paths.
        let filePath = document.fileName;

        let args = [];
        args.push("-q");
        if (standard !== '') {
            args.push("--standard=" + standard);
        }
        args.push(`--stdin-path=${filePath}`);
        args.push("-");
        return args;
    }

    /**
     * run the fixer process
     * @param document
     */
    private async format(document: TextDocument) {
        if (document.languageId !== 'php' || this.config.fixerEnable === false) {
            return '';
        }
        if (this.config.debug) {
            console.time("fixer");
        }

        // setup and spawn fixer process
        const standard = await new StandardsPathResolver(document, this.config).resolve();

        const lintArgs = this.getArgs(document, standard);

        let fileText = document.getText();

        const options = {
            cwd: this.config.workspaceRoot !== null ? this.config.workspaceRoot : undefined,
            env: process.env,
            encoding: "utf8",
            timeout: this.config.timeout,
            tty: true,
            input: fileText
        };

        if (this.config.debug) {
            console.log("----- FIXER -----");
            console.log("FIXER args: " + this.config.executablePathCBF + " " + lintArgs.join(" "));
        }

        const fixer = spawn.sync(this.config.executablePathCBF, lintArgs, options);
        const stdout = fixer.stdout.toString().trim();

        let fixed = stdout + "\n";

        let errors: { [key: number]: string } = {
            3: "FIXER: A general script execution error occurred.",
            16: "FIXER: Configuration error of the application.",
            32: "FIXER: Configuration error of a Fixer.",
            64: "FIXER: Exception raised within the application.",
            255: "FIXER: A Fatal execution error occurred."
        };

        let error: string = '';
        let result: string = '';
        let message: string = 'No fixable errors were found.';

        /**
        * fixer exit codes:
        * Exit code 0 is used to indicate that no fixable errors were found, so nothing was fixed
        * Exit code 1 is used to indicate that all fixable errors were fixed correctly
        * Exit code 2 is used to indicate that FIXER failed to fix some of the fixable errors it found
        * Exit code 3 is used for general script execution errors
        */
        switch (fixer.status) {
            case null: {
                // deal with some special case errors
                error = 'A General Execution error occurred.';
                const execError: ConsoleError = fixer.error;

                if (execError.code === 'ETIMEDOUT') {
                    error = 'FIXER: Formating the document is taking longer than the configured formatOnSaveTimeout. Consider setting to at least 2 seconds (2000).';
                }

                if (execError.code === 'ENOENT') {
                    error = 'FIXER: ' + execError.message + '. executablePath not found.';
                }
                break;
            }
            case 0: {
                if (this.config.debug) {
                    window.showInformationMessage(message);
                }
                break;
            }
            case 1: {
                if (fixed.length > 0 && fixed !== fileText) {
                    result = fixed;
                    message = 'All fixable errors were fixed correctly.';
                }

                if (this.config.debug) {
                    window.showInformationMessage(message);
                }

                break;
            }
            case 2: {
                if (fixed.length > 0 && fixed !== fileText) {
                    result = fixed;
                    message = 'FIXER failed to fix some of the fixable errors.';
                }

                if (this.config.debug) {
                    window.showInformationMessage(message);
                }
                break;
            }
            default:
                error = errors[fixer.status];
        }

        if (this.config.debug) {
            console.log(fixer);
            console.timeEnd("fixer");
            console.log("----- FIXER END -----");
        }

        if (error !== '') {
            return Promise.reject(error);
        }

        return result;
    }

    /**
     * Setup wrapper to format for extension
     * @param document
     */
    public registerDocumentProvider(document: TextDocument): ProviderResult<TextEdit[]> {
        return new Promise((resolve, reject) => {
            let lastLine = document.lineAt(document.lineCount - 1);
            let range = new Range(
                new Position(0, 0),
                lastLine.range.end
            );

            this.format(document)
                .then(text => {
                    if (text.length > 0) {
                        resolve([new TextEdit(range, text)]);
                    }
                    resolve();
                })
                .catch(err => {
                    window.showErrorMessage(err);
                    reject();
                });
        });
    }
}