import type { Extension } from '../../../extension.js';

/**
 * Config for the weather-tool extension.
 *
 * Passed by the extension loader from the host's config object.
 * The key `fetchWeather` should be declared in extension.json's `configKeys`.
 */
export interface WeatherToolConfig {
  /**
   * Custom weather fetcher. Default: returns fake data
   * ("It's 72°F and sunny in {city}."). Replace with a real API call.
   */
  fetchWeather?: (city: string) => Promise<string>;
}

/**
 * weather-tool extension — registers a `get_weather` tool.
 *
 * Demonstrates the simplest tool-registering extension. Accepts an
 * optional `fetchWeather` function via config for real API integration.
 */
export default function createWeatherToolExtension(
  config?: WeatherToolConfig,
): Extension {
  const fetchWeather =
    config?.fetchWeather ??
    (async (city: string) => `It's 72\u00b0F and sunny in ${city}.`);

  return {
    name: 'weather-tool',
    priority: 50,
    install(agent) {
      agent.tool({
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'The city name' },
          },
          required: ['city'],
        },
        async execute(args) {
          const city = args.city as string;
          const content = await fetchWeather(city);
          return { toolCallId: '', content };
        },
      });
    },
  };
}
