// SPDX-License-Identifier: Apache-2.0

export function modelDisplayName(model: string): string {
  return model.replace(/^(claude-.+)-\d{8}$/, '$1');
}
