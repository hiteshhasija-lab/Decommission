// vSphere through govc (VMware's govmomi CLI, SOAP API). Works against a standalone ESXi host (the lab)
// and against vCenter. In the lab, hand-written REST calls to the ESXi hosts were unreliable and govc
// was not, which is why this adapter comes first; a vCenter REST adapter can sit beside it later.
//
// execFile, never a shell: the VM's inventory path is always its own argv entry. Names are checked
// against a strict pattern before they reach govc's -name glob.
const { execFile } = require('child_process');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/;

function createVsphere(cfg, { exec = execFile } = {}) {
  const v = cfg.vsphere;

  function urlFor(host) {
    if (v.mode === 'vcenter') return v.url.replace(/\/+$/, '').replace(/(\/sdk)?$/, '/sdk');
    if (!host || !host.ip) throw new Error('The CMDB gives no IP address for the VM\'s host.');
    if (v.allowedHosts.length && !v.allowedHosts.includes(host.ip)) throw new Error(`Host ${host.ip} is not in VSPHERE_ALLOWED_HOSTS.`);
    return `https://${host.ip}/sdk`;
  }

  function govc(host, args, timeoutMs = 30000) {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || '/tmp',
      GOVC_URL: urlFor(host),
      GOVC_USERNAME: v.user,
      GOVC_PASSWORD: v.password,
      ...(v.insecure ? { GOVC_INSECURE: '1' } : {}),
    };
    return new Promise((resolve, reject) => {
      exec('govc', args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const text = err.killed
          ? `timed out after ${Math.round(timeoutMs / 1000)} s waiting for vSphere; the host may still have done it`
          : String(stderr || err.message).replace(/^Command failed:[^\n]*\n?/, '').trim();
        reject(new Error(`govc ${args[0]}: ${text}`));
      });
    });
  }

  const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined) return o[k]; return undefined; };

  function toVm(path, raw) {
    const config = pick(raw, 'config', 'Config') || {};
    const hw = pick(config, 'hardware', 'Hardware') || {};
    const runtime = pick(raw, 'runtime', 'Runtime') || {};
    const guest = pick(raw, 'guest', 'Guest') || {};
    const devices = pick(hw, 'device', 'Device') || [];
    const diskBytes = devices.reduce((sum, d) => {
      const bytes = pick(d, 'capacityInBytes', 'CapacityInBytes');
      const kb = pick(d, 'capacityInKB', 'CapacityInKB');
      return sum + (bytes > 0 ? bytes : kb > 0 ? kb * 1024 : 0);
    }, 0);
    return {
      ref: path,
      name: pick(config, 'name', 'Name') || path.split('/').pop(),
      uuid: pick(config, 'uuid', 'Uuid') || null,
      instanceUuid: pick(config, 'instanceUuid', 'InstanceUuid') || null,
      ip: pick(guest, 'ipAddress', 'IpAddress') || null,
      powerState: pick(runtime, 'powerState', 'PowerState') || null,
      toolsRunning: pick(guest, 'toolsRunningStatus', 'ToolsRunningStatus') === 'guestToolsRunning',
      size: {
        cpu: pick(hw, 'numCPU', 'NumCPU') || null,
        memoryMb: pick(hw, 'memoryMB', 'MemoryMB') || null,
        diskGb: diskBytes ? Math.round((diskBytes / 1073741824) * 10) / 10 : null,
      },
    };
  }

  async function info(host, path) {
    const out = JSON.parse(await govc(host, ['vm.info', '-json', path]));
    const raw = (pick(out, 'virtualMachines', 'VirtualMachines') || [])[0];
    return raw ? toVm(path, raw) : null;
  }

  async function findVm({ host, name, uuid }) {
    if (uuid) {
      // By UUID first (the CMDB's link to vSphere), then fall back to the name.
      try {
        const out = JSON.parse(await govc(host, ['vm.info', '-json', '-vm.uuid', uuid]));
        const raw = (pick(out, 'virtualMachines', 'VirtualMachines') || [])[0];
        if (raw) {
          const name2 = pick(pick(raw, 'config', 'Config') || {}, 'name', 'Name');
          const paths = await findPaths(host, name2);
          if (paths.length === 1) return toVm(paths[0], raw);
        }
      } catch (e) {
        if (!/not found|no such vm/i.test(e.message)) throw e;
      }
    }
    if (!SAFE_NAME.test(String(name || ''))) throw new Error(`Refusing to look up an unusual VM name: ${JSON.stringify(name)}`);
    const paths = await findPaths(host, name);
    if (paths.length > 1) throw new Error(`more than one VM is named ${name} (${paths.join(', ')})`);
    if (!paths.length) return null;
    return info(host, paths[0]);
  }

  async function findPaths(host, name) {
    const out = await govc(host, ['find', '/', '-type', 'm', '-name', name]);
    return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => p.split('/').pop().toLowerCase() === String(name).toLowerCase());
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(host, vm, state, seconds) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      const now = await info(host, vm.ref).catch(() => null);
      if (now && now.powerState === state) return true;
      await sleep(5000);
    }
    return false;
  }

  // Graceful guest shutdown through VMware Tools when they run, then a hard power-off if it is still
  // on after the timeout. Verified off before returning.
  async function shutdown(vm, { host, timeoutSeconds = 180 }) {
    const current = await info(host, vm.ref);
    if (!current) throw new Error(`${vm.name} disappeared before the shutdown.`);
    if (current.powerState === 'poweredOff') return 'already_off';
    let how = 'hard';
    if (current.toolsRunning) {
      await govc(host, ['vm.power', '-s', vm.ref], 60000);
      if (await waitFor(host, vm, 'poweredOff', timeoutSeconds)) how = 'graceful';
    }
    if (how === 'hard') await govc(host, ['vm.power', '-off', vm.ref], 120000);
    if (!(await waitFor(host, vm, 'poweredOff', 60))) throw new Error(`${vm.name} is still not powered off.`);
    return how;
  }

  async function powerOn(vm, { host }) {
    await govc(host, ['vm.power', '-on', vm.ref], 120000);
    if (!(await waitFor(host, vm, 'poweredOn', 60))) throw new Error(`${vm.name} did not power on.`);
  }

  async function destroy(vm, { host }) {
    await govc(host, ['vm.destroy', vm.ref], 300000);
    const left = await findPaths(host, vm.name);
    if (left.includes(vm.ref)) throw new Error(`${vm.name} is still there after the delete.`);
  }

  // Read-only connection check for `decom check`. `about` answers without a login, so the VM count
  // (which needs one) is what proves the credentials work.
  async function about(host) {
    const name = (await govc(host, ['about'])).split('\n')[0].replace(/^FullName:\s*/, '').trim();
    const vms = (await govc(host, ['find', '/', '-type', 'm'])).split('\n').filter(Boolean).length;
    return `${name}; logged in, ${vms} VM${vms === 1 ? '' : 's'} visible`;
  }

  return { findVm, shutdown, powerOn, destroy, about, _toVm: toVm };
}

module.exports = { createVsphere };
