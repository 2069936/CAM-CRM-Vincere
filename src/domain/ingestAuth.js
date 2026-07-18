// Authenticate + route an incoming NinjaTrader auto-import upload.
//
// The client is identified by its product_key (the per-client Whop key already
// stored on the client record) — no shared API key. The first upload for a
// product_key binds the source machine (VPS); later uploads must come from the
// same machine, so a leaked product_key alone cannot push data from a different
// machine.
//
// `admin` is a Supabase service-role client, created by the endpoint (this stays
// server-side). Returns { clientId, bound } on success — `bound` is true only on
// the first upload that registered the machine. Throws an Error with a `.status`
// on any failure so the endpoint can map it to an HTTP code.

export async function resolveClientForIngest(admin, { productKey, machineId } = {}) {
  const key = String(productKey || '').trim();
  const machine = String(machineId || '').trim();
  if (!key) throw Object.assign(new Error('Missing product key.'), { status: 401 });
  if (!machine) throw Object.assign(new Error('Missing machine id.'), { status: 400 });

  // 1. Resolve the client from its product_key.
  const { data: client, error: clientError } = await admin
    .from('clients')
    .select('id')
    .eq('product_key', key)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!client?.id) throw Object.assign(new Error('Invalid product key.'), { status: 401 });
  const clientId = client.id;

  // 2. Look up any machine already bound to this product_key.
  const { data: device, error: deviceError } = await admin
    .from('ingest_devices')
    .select('id, machine_id')
    .eq('product_key', key)
    .maybeSingle();
  if (deviceError) throw deviceError;

  // 3a. First upload — bind this machine to the client's product_key.
  if (!device) {
    const { error: insertError } = await admin
      .from('ingest_devices')
      .insert({ product_key: key, client_id: clientId, machine_id: machine });
    if (insertError) throw insertError;
    return { clientId, bound: true };
  }

  // 3b. Subsequent upload — the machine must match the bound one.
  if (device.machine_id !== machine) {
    throw Object.assign(
      new Error('Product key is bound to a different machine.'),
      { status: 403 },
    );
  }
  return { clientId, bound: false };
}
