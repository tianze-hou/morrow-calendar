import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { currentUser } from '../middleware/auth';
import { createToken, deleteToken, listTokens, revokeToken } from '../repository/tokens';
import { createTokenSchema, toValidationError } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** GET /api/tokens —— 列出自己的令牌（永远不返回明文）。 */
router.get(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const tokens = await listTokens(user.id);
    res.json({
      ok: true,
      data: tokens,
      meta: {
        count: tokens.length,
        maxTokens: config.limits.maxTokens,
        usage: '创建令牌后请立即保存明文，离开本页就再也看不到。请求时带 Authorization: Bearer <token>。',
      },
    });
  }),
);

/** POST /api/tokens —— 创建令牌；明文只在这里返回一次。 */
router.post(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = createTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);

    const created = await createToken(user.id, parsed.data.name, parsed.data.ttlDays ?? null);
    res.status(201).json({
      ok: true,
      data: created,
      meta: {
        warning: '这是唯一一次能看到完整令牌的机会，请立刻复制保存。',
        usage: `Authorization: Bearer ${created.prefix}…`,
      },
    });
  }),
);

/** POST /api/tokens/:id/revoke —— 吊销但保留记录，便于审计。 */
router.post(
  '/:id/revoke',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const token = await revokeToken(user.id, req.params.id);
    res.json({ ok: true, data: token });
  }),
);

/** DELETE /api/tokens/:id —— 彻底删除记录。 */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const user = currentUser(req);
    if (!req.params.id) throw badRequest('缺少令牌 id');
    await deleteToken(user.id, req.params.id);
    res.json({ ok: true, data: { id: req.params.id, deleted: true } });
  }),
);

export default router;
