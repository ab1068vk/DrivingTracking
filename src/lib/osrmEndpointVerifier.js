import { checkOsrmEndpointHealth, buildOsrmHealthPatch } from '@/lib/osrmEndpointHealth';
import { hasVerifiedOsrmEndpoint } from '@/lib/osrmEndpointTrust';
import { localSettings } from '@/lib/trackingStore';

export async function reverifyConfiguredOsrmEndpoint(settings = localSettings.get()) {
  if (!settings.osrm_map_matching_url || settings.osrm_data_sharing_consented !== true) {
    return { changed: false, settings, result: null };
  }

  const result = await checkOsrmEndpointHealth(settings.osrm_map_matching_url);
  const healthPatch = buildOsrmHealthPatch(result);
  const securityPatch = result.ok
    ? {}
    : {
        map_matching_enabled: false,
        osrm_data_sharing_consented: false,
      };
  const next = localSettings.update({ ...healthPatch, ...securityPatch });

  return {
    changed: !result.ok || !hasVerifiedOsrmEndpoint(settings),
    settings: next,
    result,
  };
}
