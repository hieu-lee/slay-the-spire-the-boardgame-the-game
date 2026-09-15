import { createCampaignProgress, parseCampaignProgress, type CampaignProgress } from './game/campaign.ts'

export const CAMPAIGN_KEY = 'sts-physical-campaign'

export function savedCampaign(): CampaignProgress {
  try { return parseCampaignProgress(JSON.parse(localStorage.getItem(CAMPAIGN_KEY) ?? '{}')) }
  catch { return createCampaignProgress() }
}
