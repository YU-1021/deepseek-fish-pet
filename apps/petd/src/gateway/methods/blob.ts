/**
 * 附件方法：blob.*。
 *
 * 附件存在工作区 `blobs/`（Git 忽略，无提交），内容寻址、统一句柄 `blob:<文件名>`；
 * 模型在聊天里可以通过 list_blobs / read_blob / save_blob 工具使用它们。
 */
import { Type } from '@sinclair/typebox';
import { PetdError } from '@petd/protocol';
import type { MethodRegistry } from '../registry.js';
import type { BlobStore } from '../../memory/blob.js';

const BlobMetaSchema = Type.Object({
  handle: Type.String(),
  path: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer(),
  sha256: Type.String(),
  createdAt: Type.String(),
});

export interface BlobMethodDeps {
  blobs: BlobStore;
}

function decodeBase64(dataBase64: string): Buffer {
  const cleaned = dataBase64.replace(/\s+/g, '');
  if (cleaned === '') throw new PetdError('E_BAD_PARAMS', '附件内容为空');
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    throw new PetdError('E_BAD_PARAMS', 'dataBase64 不是合法的 base64');
  }
}

export function registerBlobMethods(reg: MethodRegistry, deps: BlobMethodDeps): void {
  reg.register(
    {
      name: 'blob.put',
      scope: 'write',
      description: '存一个附件（图片/文件），返回句柄 blob:<文件名>；同样内容只存一份',
      params: Type.Object({
        dataBase64: Type.String({ maxLength: 16 * 1024 * 1024 }),
        name: Type.Optional(Type.String({ maxLength: 120 })),
        mime: Type.Optional(Type.String({ maxLength: 120 })),
      }),
      result: BlobMetaSchema,
    },
    async (params) => {
      const p = params as { dataBase64: string; name?: string; mime?: string };
      return deps.blobs.put({
        data: decodeBase64(p.dataBase64),
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.mime === undefined ? {} : { mime: p.mime }),
      });
    }
  );

  reg.register(
    {
      name: 'blob.list',
      scope: 'read',
      description: '列出工作区附件（按修改时间从新到旧）',
      params: Type.Object({}),
      result: Type.Object({ blobs: Type.Array(BlobMetaSchema) }),
    },
    async () => ({ blobs: deps.blobs.list() })
  );

  reg.register(
    {
      name: 'blob.info',
      scope: 'read',
      description: '查一个附件的元数据（句柄可写 blob:<文件名> 或 blobs/<文件名>）',
      params: Type.Object({ ref: Type.String({ maxLength: 400 }) }),
      result: BlobMetaSchema,
    },
    async (params) => deps.blobs.resolve((params as { ref: string }).ref)
  );

  reg.register(
    {
      name: 'blob.get',
      scope: 'read',
      description: '读附件原始内容（base64，适合图片等二进制）',
      params: Type.Object({ ref: Type.String({ maxLength: 400 }) }),
      result: Type.Object({ meta: BlobMetaSchema, dataBase64: Type.String() }),
    },
    async (params) => {
      const { meta, data } = deps.blobs.getBytes((params as { ref: string }).ref);
      return { meta, dataBase64: data.toString('base64') };
    }
  );

  reg.register(
    {
      name: 'blob.delete',
      scope: 'write',
      description: '删除附件（物理删除，不进 Git 历史）',
      params: Type.Object({ ref: Type.String({ maxLength: 400 }) }),
      result: Type.Object({ path: Type.String(), deleted: Type.Boolean() }),
    },
    async (params) => deps.blobs.remove((params as { ref: string }).ref)
  );
}
