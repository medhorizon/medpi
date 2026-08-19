import {
  createAgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import labExtension from "@medpi/lab/extension";
import scienceExtension from "@medpi/science/extension";

const APPLICATION_EXTENSIONS: InlineExtension[] = [
  { name: "medpi-lab", factory: labExtension },
  { name: "medpi-science", factory: scienceExtension },
];

/** Create Pi services with MedPi capabilities registered by the application. */
export function createMedPiAgentSessionServices(options: CreateAgentSessionServicesOptions) {
  return createAgentSessionServices({
    ...options,
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      extensionFactories: [
        ...APPLICATION_EXTENSIONS,
        ...(options.resourceLoaderOptions?.extensionFactories ?? []),
      ],
    },
  });
}
