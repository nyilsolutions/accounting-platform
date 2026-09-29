'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canAssignRole,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLES,
  type InvitationDto,
  type MemberDto,
  type Role,
} from '@acct/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  SelectInput,
  Spinner,
  TextInput,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { keys, useAccess, useMe } from '@/lib/queries';

export default function UsersPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const qc = useQueryClient();
  const me = useMe();
  const access = useAccess(companyId);
  const members = useQuery({
    queryKey: keys.members(companyId),
    queryFn: () => api<MemberDto[]>(`/companies/${companyId}/members`),
  });
  const invitations = useQuery({
    queryKey: keys.invitations(companyId),
    queryFn: () => api<InvitationDto[]>(`/companies/${companyId}/invitations`),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManage = access.can('users.manage');
  const myRole = access.data?.role;
  const assignable = myRole ? ROLES.filter((r) => canAssignRole(myRole, r)) : [];

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.members(companyId) }),
      qc.invalidateQueries({ queryKey: keys.invitations(companyId) }),
    ]);

  const mutate = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onError: (err) => setError(errorMessage(err)),
    onSuccess: refresh,
  });

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const email = String(f.get('email'));
    mutate.mutate(
      () =>
        api(`/companies/${companyId}/invitations`, {
          method: 'POST',
          body: { email, role: f.get('role') },
        }),
      {
        onSuccess: () => {
          form.reset();
          setNotice(`Invitation sent to ${email}.`);
        },
      },
    );
  }

  if (members.isPending || access.isPending) return <Spinner />;

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Control who can see and change this company's books."
      />
      <div className="space-y-6">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}

        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.data?.map((m) => {
                  const editable =
                    canManage && myRole !== undefined && canAssignRole(myRole, m.role);
                  return (
                    <tr key={m.id} data-testid={`member-${m.email}`}>
                      <td className="px-4 py-2.5 font-medium">
                        {m.fullName} {m.userId === me.data?.user.id && <Badge>You</Badge>}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">{m.email}</td>
                      <td className="px-4 py-2.5">
                        {editable ? (
                          <select
                            aria-label={`Role for ${m.email}`}
                            value={m.role}
                            onChange={(e) =>
                              mutate.mutate(() =>
                                api(`/companies/${companyId}/members/${m.id}`, {
                                  method: 'PATCH',
                                  body: { role: e.target.value },
                                }),
                              )
                            }
                            className="rounded border border-gray-300 px-2 py-1"
                          >
                            {assignable.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {editable && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${m.email} from this company? They will lose access immediately.`,
                                )
                              ) {
                                mutate.mutate(() =>
                                  api(`/companies/${companyId}/members/${m.id}`, {
                                    method: 'DELETE',
                                  }),
                                );
                              }
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {canManage && (
          <Card className="p-5">
            <h2 className="mb-4 font-semibold">Invite a user</h2>
            <form onSubmit={invite} className="grid items-end gap-4 sm:grid-cols-[1fr_16rem_auto]">
              <TextInput label="Email" name="email" type="email" required />
              <SelectInput
                label="Role"
                name="role"
                defaultValue="standard"
                options={assignable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              />
              <Button type="submit" loading={mutate.isPending}>
                Send invitation
              </Button>
            </form>
          </Card>
        )}

        {(invitations.data?.length ?? 0) > 0 && (
          <Card>
            <h2 className="border-b border-gray-200 px-4 py-3 font-semibold">
              Pending invitations
            </h2>
            <ul className="divide-y divide-gray-100 text-sm">
              {invitations.data!.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between px-4 py-2.5">
                  <span>
                    {inv.email} · {ROLE_LABELS[inv.role]}{' '}
                    <span className="text-gray-500">
                      (expires {new Date(inv.expiresAt).toLocaleDateString()})
                    </span>
                  </span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        mutate.mutate(() =>
                          api(`/companies/${companyId}/invitations/${inv.id}`, {
                            method: 'DELETE',
                          }),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <RoleReference />
      </div>
    </>
  );
}

function RoleReference() {
  return (
    <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium">What can each role do?</summary>
      <dl className="mt-3 space-y-2">
        {ROLES.map((r: Role) => (
          <div key={r}>
            <dt className="font-medium">{ROLE_LABELS[r]}</dt>
            <dd className="text-gray-600">{ROLE_PERMISSIONS[r].join(', ')}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
