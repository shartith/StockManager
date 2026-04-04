import pino from 'pino';

function getPrettyTransport(): pino.TransportSingleOptions | undefined {
  // Only use pino-pretty in development when it's available
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
  } catch {
    return undefined;
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: getPrettyTransport(),
});

export default logger;
