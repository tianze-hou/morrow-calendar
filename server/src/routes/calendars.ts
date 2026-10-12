import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config';
import { currentUser } from '../middleware/auth';
import {
  createCalendar,
  deleteCalendar,
  ensureDefaultCalendar,
  listCalendars,
  updateCalendar,
} from '../repository/calendars';
import { createCalendarSchema, toValidationError, updateCalendarSchema } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** GET /api/calendars —— 列出自己的日历分组（含默认分组）。 */
router.get(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    await ensureDefaultCalendar(user.id); // 兜底：任何时刻都必须有默认分组
    const calendars = await listCalendars(user.id);
    res.json({
      ok: true,
      data: calendars,
      meta: {
        count: calendars.length,
        maxCalendars: config.limits.maxCalendars,
        visibleIds: calendars.filter((c) => c.visible).map((c) => c.id),
      },
    });
  }),
);

/** POST /api/calendars —— 新建分组。 */
router.post(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = createCalendarSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);
    const created = await createCalendar(user.id, parsed.data);
    res.status(201).json({ ok: true, data: created });
  }),
);

/** PATCH /api/calendars/:id —— 改名 / 换色 / 切换可见性 / 调整排序。 */
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = updateCalendarSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);
    const updated = await updateCalendar(user.id, req.params.id, parsed.data);
    res.json({ ok: true, data: updated });
  }),
);

/** DELETE /api/calendars/:id —— 删除分组，组内日程迁到默认分组而不是一起消失。 */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const result = await deleteCalendar(user.id, req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { note: `该分组下的 ${result.movedEvents} 条日程已迁入默认分组` },
    });
  }),
);

export default router;
