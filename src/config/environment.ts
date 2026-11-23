/**
 * The environment variables of the service after their check. Every setting is required, as the conventions of the
 * infra repo require.
 */
export interface Environment {
  PORT: number;
  // The address to listen on, 0.0.0.0 in a container and 127.0.0.1 on the host.
  HOST: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  ENGINE_URL: string;
}

/**
 * The validate function of ConfigModule, which gets the variables of the environment and of the .env files. It
 * returns only the settings of the service, and a missing or invalid one stops the service at startup with an error
 * that names the variable. The errors never contain a value, because the URLs hold passwords.
 */
export function validateEnvironment(
  variables: Record<string, unknown>,
): Environment {
  return {
    PORT: readPort(variables, 'PORT'),
    HOST: readRequired(variables, 'HOST'),
    REDIS_URL: readUrl(variables, 'REDIS_URL', ['redis:', 'rediss:']),
    RABBITMQ_URL: readUrl(variables, 'RABBITMQ_URL', ['amqp:', 'amqps:']),
    ENGINE_URL: readUrl(variables, 'ENGINE_URL', ['http:', 'https:']),
  };
}

function readRequired(
  variables: Record<string, unknown>,
  name: string,
): string {
  const value = variables[name];
  if (typeof value !== 'string' || !value) {
    throw new Error(`The ${name} environment variable is required.`);
  }

  return value;
}

// Only decimal digits, because Number() would also accept values such as 1e3, 0x0bb9 or 3001.0.
function readPort(variables: Record<string, unknown>, name: string): number {
  const value = readRequired(variables, name);
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(
      `The ${name} environment variable must be a port number from 1 to 65535.`,
    );
  }

  return port;
}

function readUrl(
  variables: Record<string, unknown>,
  name: string,
  protocols: string[],
): string {
  const value = readRequired(variables, name);
  const url = URL.parse(value);
  if (!url || !protocols.includes(url.protocol)) {
    const schemes = protocols.map((protocol) => `${protocol}//`).join(' or ');
    throw new Error(
      `The ${name} environment variable must be a URL that starts with ${schemes}.`,
    );
  }

  return value;
}
