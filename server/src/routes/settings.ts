import { Router, type NextFunction, type Request, type Response } from 'express';
import { DEFAULT_SETTINGS, THEMES, VIEWS } from '../../../shared/types';
import { validationFailed } from '../lib/errors';
import { currentUser } from '../middleware/auth';
import { getSettings, resetSettings, updateSettings } from '../repository/settings';
import { settingsSchema } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** GET /api/settings —— 读取当前用户的界面设置 */
router.get(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const result = await getSettings(user.id);
    res.json({
      ok: true,
      data: result.settings,
      meta: {
        source: result.source,
        ownerId: user.id,
        defaults: DEFAULT_SETTINGS,
        available: { themes: THEMES, views: VIEWS },
      },
    });
  }),
);

/** PUT /api/settings —— 局部更新（只传要改的字段） */
router.put(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationFailed(
        parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
        '可选字段：theme / timeFormat / firstDayOfWeek / defaultView / sidebarOpen。',
      );
    }
    if (Object.keys(parsed.data).length === 0) {
      throw validationFailed([{ field: '(root)', message: '至少需要提供一个待更新字段' }]);
    }
    const settings = await updateSettings(user.id, parsed.data);
    res.json({ ok: true, data: settings, meta: { updated: Object.keys(parsed.data) } });
  }),
);

/** POST /api/settings/reset —— 恢复出厂设置（只影响当前用户） */
router.post(
  '/reset',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const settings = await resetSettings(user.id);
    res.json({ ok: true, data: settings, meta: { reset: true } });
  }),
);

export default router;
