import { Request, Response } from 'express';
import { VoucherService } from '../services/voucher.service';
import { ProfileService } from '../services/profile.service';
import { AccountingService } from '../services/accounting.service';

const voucherService = new VoucherService();
const profileService = new ProfileService();
const accountingService = new AccountingService();

export class HotspotController {
  // GET /api/dashboard/kpis
  public async getKpis(req: Request, res: Response) {
    try {
      const data = await accountingService.getDashboardKpis(req.user!);
      return res.json(data);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  }

  // POST /api/vouchers/batches
  public async generateVoucherBatch(req: Request, res: Response) {
    try {
      const result = await voucherService.generateBatch(req.body, req.user!);
      return res.status(201).json(result);
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  }

  // GET /api/vouchers/batches/:batchId/print
  public async getBatchForPrint(req: Request, res: Response) {
    try {
      const batchId = Number(req.params.batchId);
      const result = await voucherService.getBatchCardsForPrint(batchId, req.user!);
      return res.json(result);
    } catch (error: any) {
      return res.status(404).json({ message: error.message });
    }
  }

  // GET /api/profiles
  public async listProfiles(_req: Request, res: Response) {
    try {
      const profiles = await profileService.listProfiles();
      return res.json(profiles);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  }

  // POST /api/profiles
  public async createProfile(req: Request, res: Response) {
    try {
      const profile = await profileService.createProfile(req.body);
      return res.status(201).json(profile);
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  }

  // PUT /api/profiles/:id
  public async updateProfile(req: Request, res: Response) {
    try {
      const profile = await profileService.updateProfile(Number(req.params.id), req.body);
      return res.json(profile);
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  }

  // GET /api/sessions/active
  public async getActiveSessions(req: Request, res: Response) {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const sessions = await accountingService.getActiveSessions(req.user!, search);
      return res.json({ count: sessions.length, sessions });
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  }

  // POST /api/sessions/:radacctId/disconnect
  public async disconnectSession(req: Request, res: Response) {
    try {
      const radacctId = Number(req.params.radacctId);
      const result = await accountingService.disconnectSession(radacctId, req.user!);
      return res.json(result);
    } catch (error: any) {
      return res.status(400).json({ message: error.message });
    }
  }
}
