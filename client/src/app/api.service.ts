import { map } from 'rxjs';
import { normalizeClinicResponse } from './clinic-time';
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpInterceptorFn, HttpParams } from '@angular/common/http';
export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string;
  role: string;
}
export interface Doctor {
  id: number;
  name: string;
  specialization: string;
  qualification: string;
  bio: string;
  experience: number;
  fee: number;
  active: boolean | number;
}
export interface Slot {
  id: number;
  doctor_id: number;
  start_time: string;
  end_time: string;
  available: boolean | number;
}
export interface Appointment {
  id: number;
  doctor_id: number;
  patient_id: number;
  slot_id: number;
  status: string;
  reason: string;
  created_at: string;
  doctor_name: string;
  specialization: string;
  fee: number;
  start_time: string;
  end_time: string;
  patient_name?: string;
  patient_email?: string;
  cancellation_reason?: string;
  cancelled_by?: string;
  checked_in_at?: string | null;
  checked_in_by?: number | null;
  completed_at?: string | null;
  fee_paise?: number;
  fee_basis?: string;
  paid_paise?: number;
}
export interface Stats {
  doctors: number;
  patients: number;
  upcoming: number;
  completed: number;
}
export const TOKEN_KEY = 'careflow_token';
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = localStorage.getItem(TOKEN_KEY);
  return next(
    token && req.url.startsWith('/api/')
      ? req.clone({ setHeaders: { Authorization: 'Bearer ' + token } })
      : req,
  );
};
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  get<T>(url: string, params: Record<string, string> = {}) {
    return this.http
      .get<T>('/api' + url, { params: new HttpParams({ fromObject: params }) })
      .pipe(map(normalizeClinicResponse));
  }
  post<T>(url: string, body: unknown) {
    return this.http.post<T>('/api' + url, body).pipe(map(normalizeClinicResponse));
  }
  put<T>(url: string, body: unknown) {
    return this.http.put<T>('/api' + url, body).pipe(map(normalizeClinicResponse));
  }
  patch<T>(url: string, body: unknown = {}) {
    return this.http.patch<T>('/api' + url, body).pipe(map(normalizeClinicResponse));
  }
  delete<T>(url: string) {
    return this.http.delete<T>('/api' + url).pipe(map(normalizeClinicResponse));
  }
}

export interface Patient {
  id: number;
  name: string;
  email: string;
  phone?: string;
  created_at: string;
}
export interface CareNotification {
  id: number;
  user_id: number;
  title: string;
  message: string;
  appointment_id: number | null;
  reason: string | null;
  created_at: string;
  read_at: string | null;
  email_status?: string;
  mail_status?: string;
}

export interface PaymentEntry {
  id: number;
  appointment_id: number;
  kind: 'payment' | 'refund';
  amount_paise: number;
  method: string;
  reference: string;
  notes: string;
  recorded_at: string;
  original_payment_id: number | null;
  refundable_paise: number;
  recorded_by: number;
  doctor_name?: string;
  patient_name?: string;
}
export interface PaymentDetails {
  appointment: Appointment;
  entries: PaymentEntry[];
}
export interface RevenueReport {
  from: string;
  to: string;
  timezone: string;
  summary: {
    gross_paise: number;
    refunds_paise: number;
    net_paise: number;
    transaction_count: number;
    outstanding_paise: number;
    cancelled_balance_paise: number;
  };
  daily: { date: string; payments_paise: number; refunds_paise: number; net_paise: number }[];
  by_doctor: {
    doctor_id: number;
    doctor_name: string;
    payments_paise: number;
    refunds_paise: number;
    net_paise: number;
  }[];
  by_method: { method: string; payments_paise: number; refunds_paise: number; net_paise: number }[];
  appointment_status: { status: string; count: number }[];
  recent: PaymentEntry[];
}
