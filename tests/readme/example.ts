// The README quick-start, with the db stubbed. Kept compiling so the published
// example cannot silently rot. Imports use `#` paths; the README shows the
// equivalent public specifiers.
import { defineErrors, params } from '#catalogue/index'
import { httpStatusFor, redact } from '#errors/index'
import { tryCatchAsync } from '#resulttype/index'

declare const db: { query(sql: string, args: unknown[]): Promise<{ id: string }[]> }

const errors = defineErrors({
  'db.unavailable': { kind: 'availability' },
  'user.not_found': {
    kind: 'state',
    http: 404,
    exposure: 'public',
    params: params<{ userId: string }>(),
  },
})

async function findUser(id: string) {
  const [rows, error] = await tryCatchAsync(
    () => db.query('select * from users where id = $1', [id]),
    errors.toErr('db.unavailable'),
  )
  if (error) return [undefined, error] as const
  if (rows.length === 0)
    return [undefined, errors.create('user.not_found', { userId: id })] as const
  return [rows[0], undefined] as const
}

export async function route() {
  const [user, error] = await findUser('u1')
  if (error) {
    // Exhaustive: no `default`, and adding a code to findUser breaks the build.
    switch (error.code) {
      case 'user.not_found':
        return { status: httpStatusFor(error), body: redact(error, 'client_response') }
      case 'db.unavailable':
        return { status: httpStatusFor(error), body: redact(error, 'client_response') }
    }
  }
  return { status: 200, body: user }
}
