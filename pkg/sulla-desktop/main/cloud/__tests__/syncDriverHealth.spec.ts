import { SyncDriverHealth } from '../syncDriverHealth';

describe('SyncDriverHealth', () => {
  it('records an error streak and clears it after success while preserving local pending-edit count', () => {
    // risk: availability — recovery must restore an accurate observable sync state.
    let now=100;
    const health=new SyncDriverHealth({now:()=>now});
    health.setRunning(true);
    health.attempted();
    health.failed('upstream_failed');
    now=200;
    health.attempted();
    health.failed('upstream_failed');
    expect(health.snapshot()).toMatchObject({
      running:true,lastAttemptAt:200,lastError:{code:'upstream_failed',at:200},consecutiveFailures:2,
    });
    now=300;
    health.succeeded(3);
    expect(health.snapshot()).toMatchObject({
      running:true,lastAttemptAt:200,lastSuccessAt:300,lastError:null,consecutiveFailures:0,pendingLocalEdits:3,
    });
  });
});
