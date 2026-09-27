/** Wait for package installation to finish; an absent plugin is not a failed plugin. */
export async function waitForPackedPlugin(client, location, timeout = 300_000, interval = 500) {
  const deadline = Date.now() + timeout;
  let plugin;
  do {
    const checked = await client.plugin.list({ location });
    plugin = checked.data.find(item => item.id === 'kiokuko-ai');
    if (plugin?.state.status === 'active' || plugin?.state.status === 'failed') return plugin;
    if (Date.now() >= deadline) return plugin;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (true);
}
