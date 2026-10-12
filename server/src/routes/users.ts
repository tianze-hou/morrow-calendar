import { Router, type NextFunction, type Request, type Response } from 'express';
import { forbidden } from '../lib/errors';
import { currentUser, requireAdmin } from '../middleware/auth';
import { ensureDefaultCalendar } from '../repository/calendars';
import { createUser, deleteUser, listUsers, updateUser } from '../repository/users';
import { createUserSchema, toValidationError, updateUserSchema } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 非管理员只能看到自己，避免多用户信息泄露。 */
router.get(
  '/',
  wrap(async (req, res) => {
    const me = currentUser(req);
    if (me.role !== 'admin') {
      res.json({ ok: true, data: [me], meta: { scoped: true } });
      return;
    }
    const users = await listUsers();
    res.json({ ok: true, data: users });
  }),
);

/** POST /api/users —— 管理员建号。 */
router.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);

    const created = await createUser(parsed.data);
    await ensureDefaultCalendar(created.id); // 新用户立刻拥有默认分组
    res.status(201).json({ ok: true, data: created });
  }),
);

/** PATCH /api/users/:id —— 改资料 / 重置口令 / 升降角色 / 停用。 */
router.patch(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = updateUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);
    const updated = await updateUser(req.params.id, parsed.data);
    res.json({ ok: true, data: updated });
  }),
);

/** DELETE /api/users/:id —— 连带清掉其全部数据。 */
router.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const me = currentUser(req);
    if (me.id === req.params.id) {
      throw forbidden('不能删除自己', '请让另一位管理员来执行这个操作。');
    }
    await deleteUser(req.params.id);
    res.json({ ok: true, data: { id: req.params.id, deleted: true } });
  }),
);

export default router;
