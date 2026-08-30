// The README quick-start, with the db stubbed. Kept compiling so the published
// example cannot silently rot. Imports use `#` paths; the README shows the
// equivalent public specifiers.
import { defineErrors, params } from '#catalogue/index'
import { type Failure, httpStatusFor, redact } from '#errors/index'
import { err, ok, type Result, tryCatchAsync } from '#resulttype/index'

interface User {
  id: string
  email: string
}

declare const db: { query<T>(sql: string, args: unknown[]): Promise<T[]> }

const errors = defineErrors({
  'db.unavailable': { kind: 'availability' },
  'user.not_found': {
    kind: 'state',
    http: 404,
    exposure: 'public',
    params: params<{ userId: string }>(),
  },
})

async function findUser(
  id: string,
): Promise<Result<User, Failure<'db.unavailable' | 'user.not_found'>>> {
  const [rows, error] = await tryCatchAsync(
    () => db.query<User>('select * from users where id = $1', [id]),
    errors.toErr('db.unavailable'),
  )
  if (error) return err(error)

  const user = rows[0]
  if (user === undefined) return err(errors.create('user.not_found', { userId: id }))
  return ok(user)
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
  // Narrowed to User — not User | undefined, which the previous hand-built
  // tuple silently allowed through.
  const email: string = user.email
  return { status: 200, body: { email } }
}
