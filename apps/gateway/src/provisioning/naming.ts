/**
 * ACA app 名 / NFS subPath 子目录名的唯一命名源。
 *
 * Container App 名必须 ≤ 32 char, 故取 userId 去横线后的前 8 位 hex。
 * 此前同一算法散落三处 (purchase.shortHash + azure.appNameFor + azure.shareNameFor),
 * 靠注释手抄保持一致, 是潜在脑裂: 改 slice 长度只改一处, recovery (读 DB 存的名) 与
 * create/reconcile (运行时重算) 就指向两个不同的 app。收敛到这一份函数后, 全链路同源。
 *
 * 消费方: purchase 写 DB container_name/azure_files_share、azure create/reconcile/restart、
 *         buildSpec 的 volumeMount.subPath。
 */
const shortHash = (userId: string): string => userId.replace(/-/g, '').slice(0, 8);

/** ACA Container App 名 (= DB container_mapping.container_name)。 */
export const containerNameFor = (userId: string): string => `hermes-${shortHash(userId)}`;

/** 用户在共享 NFS share 内的子目录名 (= DB azure_files_share, 也是 volumeMount.subPath)。 */
export const shareNameFor = (userId: string): string => `user-${shortHash(userId)}`;
