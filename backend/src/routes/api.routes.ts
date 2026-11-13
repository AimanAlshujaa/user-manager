import { Router } from 'express';
import { HotspotController } from '../controllers/hotspot.controller';
import { authenticateJwt, requireRoles } from '../middlewares/auth.middleware';

const router = Router();
const controller = new HotspotController();

router.use(authenticateJwt);

// Dashboard KPIs (Filtered automatically by RBAC role)
router.get('/dashboard/kpis', (req, res) => controller.getKpis(req, res));

// Batch Voucher Generation & Printing (Accessible to both Super Admin & Resellers)
router.post('/vouchers/batches', (req, res) => controller.generateVoucherBatch(req, res));
router.get('/vouchers/batches/:batchId/print', (req, res) => controller.getBatchForPrint(req, res));

// Profiles Management (Read for all, Write restricted to SUPER_ADMIN)
router.get('/profiles', (req, res) => controller.listProfiles(req, res));
router.post('/profiles', requireRoles('SUPER_ADMIN'), (req, res) => controller.createProfile(req, res));
router.put('/profiles/:id', requireRoles('SUPER_ADMIN'), (req, res) => controller.updateProfile(req, res));

// Live Accounting & CoA Session Disconnect
router.get('/sessions/active', (req, res) => controller.getActiveSessions(req, res));
router.post('/sessions/:radacctId/disconnect', (req, res) => controller.disconnectSession(req, res));

export default router;
