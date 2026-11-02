// `/lab/proxmox`: the snapshot shape now lives with the real route (`page/infra-integrations/proxmox/model.ts`);
// the fixture (fixture.generated.ts) is one such snapshot, frozen.

export type {
	ProxmoxBackup,
	ProxmoxBackupJob,
	ProxmoxGuest,
	ProxmoxNode,
	ProxmoxSnapshot as ProxmoxFixture,
	ProxmoxStorage,
} from "../../page/infra-integrations/proxmox/model"
