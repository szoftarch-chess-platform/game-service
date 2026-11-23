# GS-ADR-2: Settings with @nestjs/config

**Related:** ADR-2, ADR-6, GS-ADR-1

## Context

The service reads its settings from environment variables, as the conventions of the infra repo require. In a container compose sets them. On the host a file has to provide them, and the passwords in it come from the `.env` of the infra repo, which creates the users of Redis and RabbitMQ.

## Decision

- `AppConfigModule` imports `ConfigModule.forRoot` of `@nestjs/config` with the files `.env.local` and `.env`, the function `validateEnvironment` and the cache of the values.
- A variable of the environment wins over `.env.local`, and `.env.local` wins over `.env`. A missing file is skipped.
- `validateEnvironment` checks every setting at startup, turns `PORT` into a number and returns only the settings of the service. Its errors name the variable but never contain its value.
- The other modules read the settings only through the typed `AppConfigService`, not through `ConfigService` or `process.env`.
- On the host `scripts/dev-setup.mjs` of the infra repo writes `.env` from `.env.example` at every run, and `.env.local` holds the values of the developer, such as the address of the Docker bridge on Linux. Both files stay outside version control.

## Rationale

- `@nestjs/config` is the configuration module that the NestJS documentation describes, so its loading order and its checks need no code of the service.
- The library skips a missing file by itself, so no `catch` is needed that would also hide the other errors of the file.
- A `validate` function keeps the checks of the service as plain functions, which the tests call without a Nest application and without environment variables.
- `.env` is derived from the `.env` of the infra repo, so a change by hand would be lost at the next run of the script. `.env.local` keeps such a change, which is the same convention as in Vite.
- With `AppConfigService` the names of the variables appear only in the config folder.

## Rejected alternatives

- **Own service that reads `process.env` after `process.loadEnvFile`:** it worked, but the `catch` around `process.loadEnvFile` hid every error of the file, not only a missing file, and a second file would need its own code.
- **`validationSchema` with Zod:** a further dependency for five variables that the functions of `validateEnvironment` already check.
- **Reading the `.env` of the infra repo with `expandVariables`:** the process would get every password of the infra repo, and the service would depend on the folders of the workspace.

## Consequences

- `ConfigModule.forRoot` reads the files and checks the settings when `config.module.ts` is imported. A test that imports a module with `AppConfigModule` therefore reads the `.env` files of its working folder, so the unit tests create the services with their settings directly.

## Sources

- NestJS configuration: https://docs.nestjs.com/techniques/configuration
- The Twelve-Factor App, config: https://12factor.net/config
- Vite env files: https://vite.dev/guide/env-and-mode#env-files
