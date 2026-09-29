import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteTokenFrom, signUp, startApp, type SignedInUser, type TestContext } from './helpers';

let ctx: TestContext;
let owner: SignedInUser;
let companyId: string;

beforeAll(async () => {
  ctx = await startApp();
  owner = await signUp(ctx.app, 'owner@example.com', 'Olivia Owner');
  const res = await owner.agent
    .post('/companies')
    .send({
      legalName: 'Sample Landscaping Co.',
      ein: '12-3456789',
      state: 'TX',
      fiscalYearStartMonth: 1,
    })
    .expect(201);
  companyId = res.body.id;
});
afterAll(async () => {
  await ctx?.close();
});

async function rawAuditText(): Promise<string> {
  const c = new Client({ connectionString: ctx.db.adminUrl });
  await c.connect();
  const r = await c.query(
    `select coalesce(string_agg(row_to_json(a)::text, ' '), '') as t from audit_log a`,
  );
  await c.end();
  return r.rows[0].t;
}

describe('companies', () => {
  it('creates a company, makes the creator owner, and masks the EIN', async () => {
    const res = await owner.agent.get(`/companies/${companyId}`).expect(200);
    expect(res.body).toMatchObject({
      legalName: 'Sample Landscaping Co.',
      einMasked: '**-***6789',
      state: 'TX',
    });
    expect(JSON.stringify(res.body)).not.toContain('3456789');

    const list = await owner.agent.get('/companies').expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: companyId, role: 'owner' })]);

    const access = await owner.agent.get(`/companies/${companyId}/access`).expect(200);
    expect(access.body.permissions).toContain('users.manage');
  });

  it('stores the EIN encrypted and never writes it to the audit log', async () => {
    const c = new Client({ connectionString: ctx.db.adminUrl });
    await c.connect();
    const r = await c.query('select ein_enc from companies where id = $1', [companyId]);
    await c.end();
    expect(r.rows[0].ein_enc).toMatch(/^v1:/);
    expect(r.rows[0].ein_enc).not.toContain('3456789');
    expect(await rawAuditText()).not.toContain('3456789');
  });

  it('updates only the fields sent and audits the change', async () => {
    const res = await owner.agent
      .patch(`/companies/${companyId}`)
      .send({ city: 'Austin' })
      .expect(200);
    expect(res.body).toMatchObject({ city: 'Austin', state: 'TX', fiscalYearStartMonth: 1 });

    const audit = await owner.agent
      .get(`/companies/${companyId}/audit-log?action=company.updated`)
      .expect(200);
    expect(audit.body.entries[0]).toMatchObject({
      action: 'company.updated',
      before: { city: null },
      after: { city: 'Austin' },
      actor: { email: 'owner@example.com' },
    });
  });

  it('reveals the EIN only on request, and audits the reveal', async () => {
    const res = await owner.agent.post(`/companies/${companyId}/reveal-ein`).expect(200);
    expect(res.body.ein).toBe('12-3456789');
    const audit = await owner.agent
      .get(`/companies/${companyId}/audit-log?action=company.ein_revealed`)
      .expect(200);
    expect(audit.body.entries).toHaveLength(1);
  });

  it('rejects invalid input', async () => {
    const res = await owner.agent
      .post('/companies')
      .send({ legalName: '', ein: '123' })
      .expect(400);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'ein',
      'legalName',
    ]);
  });

  it('hides companies from non-members (404, not 403)', async () => {
    const stranger = await signUp(ctx.app, 'stranger@example.com');
    await stranger.agent.get(`/companies/${companyId}`).expect(404);
    await stranger.agent.get(`/companies/${companyId}/audit-log`).expect(404);
    await stranger.agent.patch(`/companies/${companyId}`).send({ city: 'x' }).expect(404);
    await stranger.agent.get('/companies/not-a-uuid').expect(404);
    expect((await stranger.agent.get('/companies').expect(200)).body).toEqual([]);
  });
});

describe('users, invitations and roles', () => {
  let accountant: SignedInUser;
  let accountantMembershipId: string;

  it('invites a user who signs up and accepts', async () => {
    await owner.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'Accountant@Example.com', role: 'accountant' })
      .expect(201);
    const pending = await owner.agent.get(`/companies/${companyId}/invitations`).expect(200);
    expect(pending.body).toEqual([
      expect.objectContaining({ email: 'accountant@example.com', role: 'accountant' }),
    ]);

    const token = inviteTokenFrom(ctx.mailer, 'accountant@example.com');
    accountant = await signUp(ctx.app, 'accountant@example.com', 'Andy Accountant');

    const preview = await accountant.agent.get(`/invitations/${token}`).expect(200);
    expect(preview.body).toMatchObject({
      companyName: 'Sample Landscaping Co.',
      role: 'accountant',
      expired: false,
    });

    const accepted = await accountant.agent.post(`/invitations/${token}/accept`).expect(200);
    expect(accepted.body.companyId).toBe(companyId);
    await accountant.agent.post(`/invitations/${token}/accept`).expect(404);

    const members = await owner.agent.get(`/companies/${companyId}/members`).expect(200);
    expect(members.body.map((m: { email: string }) => m.email).sort()).toEqual([
      'accountant@example.com',
      'owner@example.com',
    ]);
    accountantMembershipId = members.body.find(
      (m: { email: string }) => m.email === 'accountant@example.com',
    ).id;
    expect((await owner.agent.get(`/companies/${companyId}/invitations`).expect(200)).body).toEqual(
      [],
    );
  });

  it('only the invited email can accept', async () => {
    await owner.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'intended@example.com', role: 'sales' })
      .expect(201);
    const token = inviteTokenFrom(ctx.mailer, 'intended@example.com');
    const other = await signUp(ctx.app, 'other@example.com');
    await other.agent.post(`/invitations/${token}/accept`).expect(403);
    await other.agent.get(`/companies/${companyId}`).expect(404);
  });

  it('enforces role permissions', async () => {
    // Accountant: full books, audit log, but cannot manage users.
    await accountant.agent.get(`/companies/${companyId}/audit-log`).expect(200);
    await accountant.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'x@example.com', role: 'sales' })
      .expect(403);

    // Sales-only user: can see the company, not settings, users, audit log or the EIN.
    await owner.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'sales@example.com', role: 'sales' })
      .expect(201);
    const token = inviteTokenFrom(ctx.mailer, 'sales@example.com');
    const sales = await signUp(ctx.app, 'sales@example.com');
    await sales.agent.post(`/invitations/${token}/accept`).expect(200);
    await sales.agent.get(`/companies/${companyId}`).expect(200);
    await sales.agent.patch(`/companies/${companyId}`).send({ city: 'Dallas' }).expect(403);
    await sales.agent.get(`/companies/${companyId}/members`).expect(403);
    await sales.agent.get(`/companies/${companyId}/audit-log`).expect(403);
    await sales.agent.post(`/companies/${companyId}/reveal-ein`).expect(403);
  });

  it('protects the owner role', async () => {
    // Promote accountant to admin; an admin cannot create owners or touch owners.
    await owner.agent
      .patch(`/companies/${companyId}/members/${accountantMembershipId}`)
      .send({ role: 'admin' })
      .expect(200);
    await accountant.agent
      .post(`/companies/${companyId}/invitations`)
      .send({ email: 'newowner@example.com', role: 'owner' })
      .expect(403);
    const members = await owner.agent.get(`/companies/${companyId}/members`).expect(200);
    const ownerMembership = members.body.find((m: { role: string }) => m.role === 'owner').id;
    await accountant.agent
      .patch(`/companies/${companyId}/members/${ownerMembership}`)
      .send({ role: 'admin' })
      .expect(403);
    await accountant.agent.delete(`/companies/${companyId}/members/${ownerMembership}`).expect(403);

    // The last owner cannot demote or remove themselves.
    await owner.agent
      .patch(`/companies/${companyId}/members/${ownerMembership}`)
      .send({ role: 'admin' })
      .expect(400);
    await owner.agent.delete(`/companies/${companyId}/members/${ownerMembership}`).expect(400);
  });

  it('removing a user revokes their access immediately and is audited', async () => {
    await owner.agent
      .delete(`/companies/${companyId}/members/${accountantMembershipId}`)
      .expect(204);
    await accountant.agent.get(`/companies/${companyId}`).expect(404);

    const audit = await owner.agent
      .get(`/companies/${companyId}/audit-log?action=member.`)
      .expect(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'member.invited',
        'member.invitation_accepted',
        'member.role_changed',
        'member.removed',
      ]),
    );
  });
});

describe('audit log', () => {
  it('paginates newest first with a cursor', async () => {
    const first = await owner.agent.get(`/companies/${companyId}/audit-log?limit=2`).expect(200);
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await owner.agent
      .get(`/companies/${companyId}/audit-log?limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(Number(second.body.entries[0].id)).toBeLessThan(Number(first.body.entries[1].id));
  });

  it('never exposes another company’s entries', async () => {
    const other = await owner.agent.post('/companies').send({ legalName: 'Other Co' }).expect(201);
    const res = await owner.agent.get(`/companies/${companyId}/audit-log?limit=200`).expect(200);
    expect(
      res.body.entries.every((e: { entityId: string | null }) => e.entityId !== other.body.id),
    ).toBe(true);
  });
});
