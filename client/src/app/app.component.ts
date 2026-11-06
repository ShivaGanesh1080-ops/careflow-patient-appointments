import { clinicDate, clinicMillis, clinicTimestamp, isFutureClinicTime } from './clinic-time';
import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  ApiService,
  Appointment as BaseAppointment,
  CareNotification,
  Doctor,
  Patient,
  Slot,
  Stats,
  TOKEN_KEY,
  User,
  PaymentDetails as BasePaymentDetails,
  PaymentEntry,
  RevenueReport,
} from './api.service';

import { LiveUpdatesService } from './live-updates.service';

interface Appointment extends BaseAppointment {
  waived_paise?: number;
  effective_charge_paise?: number;
  outstanding_paise?: number;
  refundable_paise?: number;
  no_show_at?: string | null;
  no_show_reason?: string | null;
}
interface ChargeAdjustment {
  amount_paise: number;
  reason: string;
  recorded_by: number | string;
  recorded_at: string;
  kind: string;
}
interface PaymentDetails extends BasePaymentDetails {
  appointment: Appointment;
  adjustments?: ChargeAdjustment[];
}
interface VisitHistory {
  kind: string;
  old_slot_id: number | null;
  new_slot_id: number | null;
  old_start_time: string | null;
  new_start_time: string | null;
  reason: string;
  recorded_at: string;
  recorded_by: number | string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  live = inject(LiveUpdatesService);
  patients = signal<Patient[]>([]);
  notifications = signal<CareNotification[]>([]);
  cancellationTarget = signal<Appointment | null>(null);
  cancellationNotice = signal<CareNotification | null>(null);
  cancellationError = signal('');
  notificationError = signal('');
  notificationBusy = signal(false);
  cancellationReason = '';
  patientSearch = '';
  private sessionEpoch = 0;
  private refreshRequestId = 0;
  private liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private cancellationPromptEligible = false;
  private promptedNotifications = new Set<number>();

  get unreadCount() {
    return this.notifications().filter((n) => !n.read_at).length;
  }
  get cancellationReasonValid() {
    const length = this.cancellationReason.trim().length;
    return length >= 5 && length <= 500;
  }
  get filteredPatients() {
    const q = this.patientSearch.trim().toLowerCase();
    return this.patients().filter(
      (p) => !q || (p.name + ' ' + p.email + ' ' + (p.phone || '')).toLowerCase().includes(q),
    );
  }
  get modalOpen() {
    return (
      !!this.selectedDoctor() ||
      this.doctorEditor() ||
      !!this.cancellationTarget() ||
      !!this.cancellationNotice() ||
      !!this.paymentTarget() ||
      !!this.visitTarget()
    );
  }
  emailStatusLabel(status: string | null | undefined) {
    return (
      (
        {
          not_configured: 'Not configured',
          pending: 'Pending',
          sent: 'Sent â€” SMTP accepted',
          failed: 'Failed',
        } as Record<string, string>
      )[status || 'not_configured'] || 'Unknown'
    );
  }
  connectLive() {
    if (!this.user() || !localStorage.getItem(TOKEN_KEY)) return;
    this.live.connect(
      () => {
        this.cancellationPromptEligible = true;
        this.scheduleLiveRefresh();
      },
      () => {
        this.cancellationPromptEligible = true;
        this.scheduleLiveRefresh();
      },
    );
  }
  scheduleLiveRefresh() {
    if (this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer = setTimeout(async () => {
      this.liveRefreshTimer = null;
      if (!this.user()) return;
      await this.refresh(true);
      if (this.selectedDoctor() || (this.visitTarget() && this.visitAction === 'reschedule'))
        await this.loadSlots(true);
    }, 16);
  }
  ngOnDestroy() {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.sessionEpoch++;
    this.refreshRequestId++;
    this.slotRequestId++;
    this.live.disconnect();
    if (this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer);
  }
  tryShowCancellationNotice() {
    if (
      !this.ready() ||
      !this.user() ||
      this.isAdmin ||
      !this.cancellationPromptEligible ||
      this.modalOpen ||
      this.busy() ||
      this.notificationBusy()
    )
      return;
    this.cancellationPromptEligible = false;
    const latest = this.notifications()
      .filter(
        (n) =>
          !n.read_at &&
          n.title === 'Appointment cancelled by clinic' &&
          !this.promptedNotifications.has(n.id),
      )
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id - a.id,
      )[0];
    if (latest) {
      this.promptedNotifications.add(latest.id);
      this.notificationError.set('');
      this.cancellationNotice.set(latest);
      this.focusDialog();
    }
  }
  async markNotificationRead(n: CareNotification) {
    if (this.notificationBusy()) return;
    this.notificationBusy.set(true);
    this.notificationError.set('');
    const epoch = this.sessionEpoch;
    try {
      const data = await firstValueFrom(
        this.api.patch<{ notification: CareNotification }>('/notifications/' + n.id + '/read'),
      );
      if (epoch !== this.sessionEpoch) return;
      this.refreshRequestId++;
      this.notifications.update((items) =>
        items.map((item) => (item.id === n.id ? data.notification : item)),
      );
      if (this.cancellationNotice()?.id === n.id) {
        this.cancellationNotice.set(null);
        this.restoreFocus();
      }
      await this.refresh(true);
    } catch (e) {
      if (epoch === this.sessionEpoch) this.notificationError.set(this.errorText(e));
    } finally {
      if (epoch === this.sessionEpoch) this.notificationBusy.set(false);
    }
  }
  async dismissCancellationNotice() {
    const notice = this.cancellationNotice();
    if (notice) await this.markNotificationRead(notice);
  }
  closeCancellationNotice() {
    if (this.notificationBusy()) return;
    this.cancellationNotice.set(null);
    this.notificationError.set('');
    this.restoreFocus();
  }
  notificationEmailStatus(n: CareNotification) {
    return n.email_status || n.mail_status || 'not_configured';
  }
  async markAllNotificationsRead() {
    if (this.notificationBusy() || !this.unreadCount) return;
    this.notificationBusy.set(true);
    this.notificationError.set('');
    const epoch = this.sessionEpoch;
    try {
      await firstValueFrom(this.api.patch('/notifications/read-all'));
      if (epoch === this.sessionEpoch) {
        const now = new Date().toISOString();
        this.notifications.update((items) =>
          items.map((n) => ({ ...n, read_at: n.read_at || now })),
        );
        await this.refresh(true);
      }
    } catch (e) {
      if (epoch === this.sessionEpoch) this.notificationError.set(this.errorText(e));
    } finally {
      if (epoch === this.sessionEpoch) this.notificationBusy.set(false);
    }
  }
  openAdminCancellation(a: Appointment) {
    if (this.busy() || !this.isAdmin) return;
    this.cancellationReason = '';
    this.cancellationError.set('');
    this.cancellationTarget.set(a);
    this.focusDialog();
  }
  closeAdminCancellation() {
    if (this.busy()) return;
    this.cancellationTarget.set(null);
    this.cancellationError.set('');
    this.restoreFocus();
    this.tryShowCancellationNotice();
  }
  async confirmAdminCancellation() {
    const target = this.cancellationTarget();
    if (!target || this.busy()) return;
    if (!this.cancellationReasonValid) {
      this.cancellationError.set(
        'Please enter a reason between 5 and 500 characters, excluding surrounding spaces.',
      );
      return;
    }
    this.busy.set(true);
    this.cancellationError.set('');
    this.clearMessages();
    try {
      await firstValueFrom(
        this.api.patch('/admin/appointments/' + target.id + '/status', {
          status: 'cancelled',
          reason: this.cancellationReason.trim(),
        }),
      );
      this.cancellationTarget.set(null);
      this.restoreFocus();
      this.success.set(
        'Appointment cancelled. The patient can read the reason in their notifications. Email delivery depends on server configuration.',
      );
      await this.refresh();
    } catch (e) {
      this.cancellationError.set(this.errorText(e));
    } finally {
      this.busy.set(false);
      this.tryShowCancellationNotice();
    }
  }
  user = signal<User | null>(null);
  ready = signal(false);
  busy = signal(false);
  loading = signal(false);
  error = signal('');
  success = signal('');
  page = signal('dashboard');
  authMode = signal('login');
  doctors = signal<Doctor[]>([]);
  appointments = signal<Appointment[]>([]);
  specializations = signal<string[]>([]);
  stats = signal<Stats>({ doctors: 0, patients: 0, upcoming: 0, completed: 0 });
  selectedDoctor = signal<Doctor | null>(null);
  slots = signal<Slot[]>([]);
  slotsLoading = signal(false);
  selectedSlot = signal<Slot | null>(null);
  doctorEditor = signal(false);
  editingDoctorId: number | null = null;
  name = '';
  email = '';
  password = '';
  phone = '';
  search = '';
  specialization = '';
  historyFilter = 'all';
  reason = '';
  bookingDate = this.localDate();
  get minDate() {
    return this.localDate();
  }
  slotDate = this.localDate();
  slotDoctorId = '';
  slotStart = '09:00';
  slotEnd = '17:00';
  slotInterval = 30;
  slotMode: 'range' | 'count' = 'range';
  slotCount = 10;
  get slotPlan() {
    const minutes = (value: string) =>
      /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')
        ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
        : NaN;
    const start = minutes(this.slotStart),
      duration = Number(this.slotInterval),
      count = Number(this.slotCount);
    if (!Number.isFinite(start) || ![15, 20, 30, 45, 60].includes(duration))
      return {
        valid: false,
        count: 0,
        end: '',
        unused: 0,
        message: 'Choose a valid start time and appointment duration.',
      };
    if (this.slotMode === 'count' && (!Number.isInteger(count) || count < 1 || count > 96))
      return {
        valid: false,
        count: 0,
        end: '',
        unused: 0,
        message: 'Enter a whole number of slots between 1 and 96.',
      };
    const end = this.slotMode === 'count' ? start + count * duration : minutes(this.slotEnd);
    if (end > 1439)
      return {
        valid: false,
        count: 0,
        end: '',
        unused: 0,
        message:
          'These slots would reach or cross midnight. Choose fewer slots, a shorter duration, or an earlier start.',
      };
    if (!Number.isFinite(end) || end - start < duration)
      return {
        valid: false,
        count: 0,
        end: '',
        unused: 0,
        message: 'The time range must fit at least one full appointment.',
      };
    const planned = Math.floor((end - start) / duration),
      unused = (end - start) % duration,
      finish =
        String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0');
    return {
      valid: true,
      count: planned,
      end: finish,
      unused,
      message:
        planned +
        ' slots Ã— ' +
        duration +
        ' minutes Â· ' +
        this.slotStart +
        'â€“' +
        finish +
        (unused ? ' Â· ' + unused + ' minutes unused' : ''),
    };
  }
  doctorForm = this.emptyDoctor();
  private clock = signal(new Date());
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  get today() {
    return this.clock();
  }
  private tickClock() {
    this.clock.set(new Date());
    this.clockTimer = setTimeout(() => this.tickClock(), 60000 - (Date.now() % 60000));
  }
  private slotRequestId = 0;
  private priorFocus: HTMLElement | null = null;
  focusDialog() {
    this.priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.modal-panel button:not([disabled])')?.focus(),
    );
  }
  restoreFocus() {
    const target = this.priorFocus;
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
      else document.querySelector<HTMLElement>('#main-content')?.focus();
    });
  }
  closeDoctorEditor() {
    if (!this.busy()) {
      this.doctorEditor.set(false);
      this.restoreFocus();
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  dialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.selectedDoctor()) this.closeBooking();
      else if (this.doctorEditor()) this.closeDoctorEditor();
      else if (this.cancellationTarget()) this.closeAdminCancellation();
      else if (this.cancellationNotice()) this.closeCancellationNotice();
      else if (this.paymentTarget()) this.closePayments();
      else if (this.visitTarget()) this.closeVisitAction();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
      ),
    ).filter((el) => el.getClientRects().length > 0);
    const first = controls[0],
      last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last && first) {
      event.preventDefault();
      first.focus();
    }
  }
  get isAdmin() {
    return this.user()?.role === 'admin';
  }
  get filteredDoctors() {
    const text = this.search.trim().toLowerCase();
    return this.doctors().filter(
      (d) =>
        (this.isAdmin || !!d.active) &&
        (!this.specialization || d.specialization === this.specialization) &&
        (!text ||
          (d.name + ' ' + d.specialization + ' ' + d.qualification).toLowerCase().includes(text)),
    );
  }
  get upcoming() {
    return this.appointments()
      .filter((a) => this.isUpcoming(a))
      .sort((a, b) => clinicMillis(a.start_time) - clinicMillis(b.start_time));
  }
  get nextAppointment() {
    return this.upcoming[0];
  }
  get filteredAppointments() {
    return this.appointments()
      .filter(
        (a) =>
          this.historyFilter === 'all' ||
          (this.historyFilter === 'upcoming'
            ? this.isUpcoming(a)
            : a.status === this.historyFilter),
      )
      .sort((a, b) => clinicMillis(b.start_time) - clinicMillis(a.start_time));
  }
  get completedCount() {
    return this.appointments().filter((a) => a.status === 'completed').length;
  }
  get firstName() {
    return this.user()?.name.split(' ')[0] || 'there';
  }
  get pageTitle() {
    return (
      (
        {
          dashboard: 'Your health, at a glance',
          doctors: 'Find your care team',
          appointments: 'Your appointments',
          profile: 'Your personal space',
          manage: 'Doctor management',
          slots: 'Availability planner',
          patients: 'People in your care',
          notifications: 'Your care updates',
          revenue: 'Revenue & insights',
        } as Record<string, string>
      )[this.page()] || 'Careflow'
    );
  }
  localDate(date = new Date()) {
    return clinicDate(date);
  }
  initials(name: string) {
    return name
      .replace(/^Dr\.?\s*/i, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0])
      .join('')
      .toUpperCase();
  }
  isUpcoming(a: Appointment) {
    return a.status === 'booked' && isFutureClinicTime(a.start_time);
  }
  canComplete(a: Appointment) {
    return a.status === 'booked' && !!a.checked_in_at;
  }
  canAdminCancel(a: Appointment) {
    return a.status === 'booked';
  }
  emptyDoctor() {
    return { name: '', specialization: '', qualification: '', bio: '', experience: 0, fee: 0 };
  }
  clearMessages() {
    this.error.set('');
    this.success.set('');
  }
  errorText(e: unknown) {
    return e instanceof HttpErrorResponse
      ? e.error?.error ||
          (e.status === 0
            ? 'We cannot reach the server. Please check that it is running and try again.'
            : 'Something went wrong. Please try again.')
      : 'Something went wrong. Please try again.';
  }
  fail(e: unknown) {
    this.error.set(this.errorText(e));
  }
  async ngOnInit() {
    this.tickClock();
    if (localStorage.getItem(TOKEN_KEY)) {
      try {
        const data = await firstValueFrom(this.api.get<{ user: User }>('/auth/me'));
        this.sessionEpoch++;
        this.user.set(data.user);
        this.cancellationPromptEligible = true;
        await this.refresh();
        this.connectLive();
      } catch (e) {
        localStorage.removeItem(TOKEN_KEY);
        this.live.disconnect();
        this.fail(e);
      }
    }
    this.ready.set(true);
    this.tryShowCancellationNotice();
  }
  async authenticate() {
    if (this.busy()) return;
    this.clearMessages();
    this.busy.set(true);
    try {
      const body =
        this.authMode() === 'login'
          ? { email: this.email, password: this.password }
          : { name: this.name, email: this.email, password: this.password, phone: this.phone };
      const data = await firstValueFrom(
        this.api.post<{ token: string; user: User }>('/auth/' + this.authMode(), body),
      );
      this.sessionEpoch++;
      localStorage.setItem(TOKEN_KEY, data.token);
      this.user.set(data.user);
      this.password = '';
      this.cancellationPromptEligible = true;
      this.promptedNotifications.clear();
      await this.refresh();
      this.connectLive();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      this.tryShowCancellationNotice();
    }
  }
  demo(role: 'patient' | 'admin') {
    this.authMode.set('login');
    this.email = role + '@careflow.demo';
    this.password = role === 'patient' ? 'Patient123!' : 'Admin123!';
  }
  logout() {
    this.sessionEpoch++;
    this.refreshRequestId++;
    this.slotRequestId++;
    this.live.disconnect();
    if (this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer = null;
    localStorage.removeItem(TOKEN_KEY);
    this.user.set(null);
    this.doctors.set([]);
    this.appointments.set([]);
    this.patients.set([]);
    this.notifications.set([]);
    this.selectedDoctor.set(null);
    this.doctorEditor.set(false);
    this.cancellationTarget.set(null);
    this.cancellationNotice.set(null);
    this.cancellationPromptEligible = false;
    this.promptedNotifications.clear();
    this.notificationBusy.set(false);
    this.notificationError.set('');
    this.patientSearch = '';
    this.revenueRequestId++;
    this.paymentRequestId++;
    this.revenue.set(null);
    this.paymentDetails.set(null);
    this.paymentTarget.set(null);
    this.visitTarget.set(null);
    this.visitRequestId++;
    this.page.set('dashboard');
    this.loading.set(false);
    this.clearMessages();
  }
  navigate(page: string) {
    this.page.set(page);
    this.clearMessages();
    if (page === 'revenue' && this.isAdmin) void this.loadRevenue();
  }
  async refresh(quiet = false) {
    if (!this.user()) return;
    const epoch = this.sessionEpoch,
      requestId = ++this.refreshRequestId,
      admin = this.isAdmin;
    if (!quiet) this.loading.set(true);
    try {
      const [d, a, s, n, patients, stats] = await Promise.all([
        firstValueFrom(
          this.api.get<{ doctors: Doctor[] }>('/doctors', admin ? { includeInactive: 'true' } : {}),
        ),
        firstValueFrom(
          this.api.get<{ appointments: Appointment[] }>(
            admin ? '/admin/appointments' : '/appointments',
          ),
        ),
        firstValueFrom(this.api.get<{ specializations: string[] }>('/specializations')),
        firstValueFrom(this.api.get<{ notifications: CareNotification[] }>('/notifications')),
        admin
          ? firstValueFrom(this.api.get<{ patients: Patient[] }>('/admin/patients'))
          : Promise.resolve(null),
        admin
          ? firstValueFrom(this.api.get<{ stats: Stats }>('/admin/stats'))
          : Promise.resolve(null),
      ]);
      if (epoch !== this.sessionEpoch || requestId !== this.refreshRequestId) return;
      this.doctors.set(d.doctors);
      this.appointments.set(a.appointments);
      this.specializations.set(s.specializations);
      this.notifications.set(
        n.notifications
          .slice()
          .sort(
            (x, y) =>
              new Date(y.created_at).getTime() - new Date(x.created_at).getTime() || y.id - x.id,
          ),
      );
      if (patients) this.patients.set(patients.patients);
      if (stats) this.stats.set(stats.stats);
      if (admin && this.page() === 'revenue') void this.loadRevenue();
      if (admin && this.paymentTarget()) void this.loadPaymentDetails(this.paymentTarget()!.id);
    } catch (e) {
      if (epoch === this.sessionEpoch && requestId === this.refreshRequestId) this.fail(e);
    } finally {
      if (epoch === this.sessionEpoch && requestId === this.refreshRequestId) {
        this.loading.set(false);
        this.tryShowCancellationNotice();
      }
    }
  }
  async openBooking(doctor: Doctor) {
    this.clearMessages();
    this.bookingDate = this.localDate();
    this.reason = '';
    this.selectedDoctor.set(doctor);
    this.focusDialog();
    await this.loadSlots();
  }
  closeBooking() {
    if (!this.busy()) {
      this.selectedDoctor.set(null);
      this.slotRequestId++;
      this.restoreFocus();
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  async loadSlots(preserveSelection = false) {
    const doctor =
      this.selectedDoctor() ||
      (this.visitAction === 'reschedule' && this.visitTarget()
        ? { id: this.visitTarget()!.doctor_id }
        : null);
    if (!doctor) return;
    const requestId = ++this.slotRequestId;
    this.slotsLoading.set(true);
    if (!preserveSelection) {
      this.selectedSlot.set(null);
      this.slots.set([]);
    }
    const requestedDate = this.bookingDate;
    if (!requestedDate || requestedDate < this.minDate) {
      this.slotsLoading.set(false);
      return;
    }
    try {
      const data = await firstValueFrom(
        this.api.get<{ slots: Slot[] }>('/doctors/' + doctor.id + '/slots', {
          date: requestedDate,
        }),
      );
      if (
        requestId === this.slotRequestId &&
        (this.selectedDoctor()?.id || this.visitTarget()?.doctor_id) === doctor.id
      ) {
        this.slots.set(data.slots);
        if (preserveSelection) {
          const current = this.selectedSlot();
          if (current)
            this.selectedSlot.set(
              data.slots.find((s) => s.id === current.id && this.slotAvailable(s)) || null,
            );
        }
      }
    } catch (e) {
      if (requestId === this.slotRequestId) {
        if (this.visitTarget()) this.visitError.set(this.errorText(e));
        else this.fail(e);
      }
    } finally {
      if (requestId === this.slotRequestId) this.slotsLoading.set(false);
    }
  }
  slotAvailable(slot: Slot) {
    return !!slot.available && isFutureClinicTime(slot.start_time);
  }
  async book() {
    const slot = this.selectedSlot();
    if (!slot || this.busy()) return;
    if (!this.slotAvailable(slot) || this.bookingDate < this.minDate) {
      this.error.set('This slot is no longer available. Choose a future time.');
      return;
    }
    if (this.reason.trim().length > 500) {
      this.error.set('Please keep the visit reason within 500 characters.');
      return;
    }
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(
        this.api.post('/appointments', { slotId: slot.id, reason: this.reason.trim() }),
      );
      this.selectedDoctor.set(null);
      this.slotRequestId++;
      this.restoreFocus();
      this.page.set('appointments');
      this.historyFilter = 'upcoming';
      this.success.set(
        'Youâ€™re booked! Your next step toward feeling your best is on the calendar.',
      );
      await this.refresh();
    } catch (e) {
      this.fail(e);
      await this.loadSlots();
    } finally {
      this.busy.set(false);
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  async cancel(a: Appointment) {
    if (
      this.busy() ||
      !window.confirm(
        'Cancel your appointment with ' +
          a.doctor_name +
          '? This will release the time for someone else.',
      )
    )
      return;
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(this.api.patch('/appointments/' + a.id + '/cancel'));
      this.success.set('Appointment cancelled. You can book a new time whenever youâ€™re ready.');
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  editDoctor(d?: Doctor) {
    this.clearMessages();
    this.editingDoctorId = d?.id ?? null;
    this.doctorForm = d
      ? {
          name: d.name,
          specialization: d.specialization,
          qualification: d.qualification,
          bio: d.bio,
          experience: d.experience,
          fee: d.fee,
        }
      : this.emptyDoctor();
    this.doctorEditor.set(true);
    this.focusDialog();
  }
  async saveDoctor() {
    if (this.busy()) return;
    if (
      this.doctorForm.bio.length > 1000 ||
      this.doctorForm.experience < 0 ||
      this.doctorForm.experience > 70
    ) {
      this.error.set(
        'Keep the biography within 1,000 characters and experience between 0 and 70 years.',
      );
      return;
    }
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(
        this.editingDoctorId
          ? this.api.put('/admin/doctors/' + this.editingDoctorId, this.doctorForm)
          : this.api.post('/admin/doctors', this.doctorForm),
      );
      this.doctorEditor.set(false);
      this.restoreFocus();
      this.success.set('Doctor details saved.');
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  async deactivate(d: Doctor) {
    if (
      this.busy() ||
      !window.confirm('Deactivate ' + d.name + '? They will no longer appear for new bookings.')
    )
      return;
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(this.api.delete('/admin/doctors/' + d.id));
      this.success.set('Doctor deactivated. Existing appointments remain in the records.');
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  async createSlots() {
    if (this.busy()) return;
    const plan = this.slotPlan;
    if (!plan.valid) {
      this.error.set(plan.message);
      return;
    }
    this.busy.set(true);
    this.clearMessages();
    try {
      const data = await firstValueFrom(
        this.api.post<{ created: number; planned: number; skipped: number }>('/admin/slots', {
          doctorId: Number(this.slotDoctorId),
          date: this.slotDate,
          startTime: this.slotStart,
          intervalMinutes: Number(this.slotInterval),
          ...(this.slotMode === 'count'
            ? { slotCount: Number(this.slotCount) }
            : { endTime: this.slotEnd }),
        }),
      );
      this.success.set(
        data.created +
          ' of ' +
          data.planned +
          ' planned slots created.' +
          (data.skipped
            ? ' ' + data.skipped + ' skipped because they overlap existing slots.'
            : ' Patients can now book these times.'),
      );
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      requestAnimationFrame(() => this.tryShowCancellationNotice());
    }
  }
  revenue = signal<RevenueReport | null>(null);
  revenueLoading = signal(false);
  revenueError = signal('');
  revenueFrom = this.financeDate(-29);
  revenueTo = this.financeDate();
  private revenueRequestId = 0;
  private paymentRequestId = 0;
  paymentTarget = signal<Appointment | null>(null);
  paymentDetails = signal<PaymentDetails | null>(null);
  paymentLoading = signal(false);
  paymentError = signal('');
  paymentKind: 'payment' | 'refund' = 'payment';
  paymentAmount = '';
  paymentMethod = 'cash';
  paymentReference = '';
  paymentNotes = '';
  refundPaymentId: number | null = null;
  paymentConfirmed = false;
  feeInput = '';
  private paymentIntent: { signature: string; key: string } | null = null;
  financeDate(offset = 0) {
    return clinicDate(new Date(), offset);
  }
  money(paise: number | undefined) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format((paise || 0) / 100);
  }
  paise(value: string) {
    if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(String(value).trim())) return null;
    const [r, f = ''] = String(value).trim().split('.');
    const n = Number(r) * 100 + Number(f.padEnd(2, '0'));
    return Number.isSafeInteger(n) && n <= 10000000 ? n : null;
  }
  get paymentBalance() {
    const a = this.paymentDetails()?.appointment;
    return a ? this.outstanding(a) : 0;
  }
  get refundOptions() {
    return (this.paymentDetails()?.entries || []).filter(
      (e) => e.kind === 'payment' && e.refundable_paise > 0,
    );
  }
  get paymentLimit() {
    if (this.paymentKind !== 'refund') return this.paymentBalance;
    const receiptLimit =
      this.refundOptions.find((e) => e.id === Number(this.refundPaymentId))?.refundable_paise || 0;
    const a = this.paymentDetails()?.appointment;
    return this.refundType === 'goodwill' && a
      ? Math.min(receiptLimit, this.effectiveCharge(a))
      : receiptLimit;
  }
  get paymentFormValid() {
    const n = this.paise(this.paymentAmount);
    return (
      n !== null &&
      n > 0 &&
      n <= this.paymentLimit &&
      this.paymentConfirmed &&
      (this.paymentKind !== 'refund' ||
        (!!this.refundPaymentId &&
          this.validActionReason(this.paymentNotes) &&
          (this.refundType !== 'goodwill' ||
            n <= this.effectiveCharge(this.paymentDetails()!.appointment)))) &&
      (this.paymentKind !== 'payment' ||
        !['cancelled', 'no_show'].includes(this.paymentDetails()?.appointment.status || ''))
    );
  }
  async loadRevenue() {
    if (!this.isAdmin) return;
    const epoch = this.sessionEpoch,
      id = ++this.revenueRequestId;
    const from = this.revenueFrom,
      to = this.revenueTo;
    if (!from || !to || from > to) {
      this.revenueLoading.set(false);
      this.revenueError.set('Choose a valid start and end date.');
      this.revenue.set(null);
      return;
    }
    this.revenueLoading.set(true);
    this.revenueError.set('');
    try {
      const data = await firstValueFrom(
        this.api.get<RevenueReport>('/admin/revenue', { from, to }),
      );
      if (epoch === this.sessionEpoch && id === this.revenueRequestId) this.revenue.set(data);
    } catch (e) {
      if (epoch === this.sessionEpoch && id === this.revenueRequestId) {
        this.revenueError.set(this.errorText(e));
        this.revenue.set(null);
      }
    } finally {
      if (epoch === this.sessionEpoch && id === this.revenueRequestId)
        this.revenueLoading.set(false);
    }
  }
  revenueRange(days: number) {
    this.revenueFrom = this.financeDate(1 - days);
    this.revenueTo = this.financeDate();
    void this.loadRevenue();
  }
  get revenuePlot() {
    const rows = this.revenue()?.daily || [],
      values = rows.map((d) => d.net_paise),
      min = Math.min(0, ...values),
      max = Math.max(0, ...values),
      span = max - min || 1;
    const x = (i: number) => 40 + (rows.length > 1 ? (i / (rows.length - 1)) * 640 : 320),
      y = (n: number) => 190 - ((n - min) / span) * 150;
    return {
      points: rows.map((d, i) => x(i).toFixed(1) + ',' + y(d.net_paise).toFixed(1)).join(' '),
      zero: y(0),
      top: this.money(max),
      bottom: this.money(min),
      first: rows[0]?.date || '',
      last: rows[rows.length - 1]?.date || '',
    };
  }
  get statusRows() {
    const counts = this.revenue()?.appointment_status || [];
    return ['booked', 'completed', 'cancelled', 'no_show'].map((status) => ({
      status,
      count: counts.find((s) => s.status === status)?.count || 0,
    }));
  }
  get statusTotal() {
    return this.statusRows.reduce((n, s) => n + s.count, 0);
  }
  get statusGradient() {
    const rows = this.statusRows,
      total = this.statusTotal;
    if (!total) return '#edf1ea';
    const colors = ['#24675f', '#899cc5', '#cc8a76', '#ad8953'];
    let end = 0;
    return (
      'conic-gradient(' +
      rows
        .map((row, i) => {
          const start = end;
          end += (row.count / total) * 100;
          return colors[i] + ' ' + start + '% ' + end + '%';
        })
        .join(',') +
      ')'
    );
  }

  doctorBar(value: number) {
    const max = Math.max(1, ...(this.revenue()?.by_doctor || []).map((d) => Math.abs(d.net_paise)));
    return (Math.abs(value) / max) * 100;
  }
  async openPayments(a: Appointment) {
    if (!this.isAdmin || this.busy() || this.modalOpen) return;
    this.paymentTarget.set(a);
    this.paymentDetails.set(null);
    this.paymentKind = ['cancelled', 'no_show'].includes(a.status) ? 'refund' : 'payment';
    this.refundType = 'correction';
    this.waiverAmount = '';
    this.waiverReason = '';
    this.waiverIntent = null;
    this.paymentAmount = '';
    this.paymentReference = '';
    this.paymentNotes = '';
    this.paymentConfirmed = false;
    this.refundPaymentId = null;
    this.paymentIntent = null;
    this.paymentError.set('');
    this.focusDialog();
    await this.loadPaymentDetails(a.id, true);
  }
  async openPaymentById(id: number) {
    const a = this.appointments().find((a) => a.id === id);
    if (a) await this.openPayments(a);
  }
  closePayments() {
    if (this.busy()) return;
    this.paymentRequestId++;
    this.paymentTarget.set(null);
    this.paymentDetails.set(null);
    this.paymentError.set('');
    this.restoreFocus();
  }
  async loadPaymentDetails(id: number, initial = false) {
    const epoch = this.sessionEpoch,
      request = ++this.paymentRequestId;
    if (initial) this.paymentLoading.set(true);
    try {
      const data = await firstValueFrom(
        this.api.get<PaymentDetails>('/admin/appointments/' + id + '/payments'),
      );
      if (
        epoch === this.sessionEpoch &&
        request === this.paymentRequestId &&
        this.paymentTarget()?.id === id
      ) {
        this.paymentDetails.set(data);
        this.paymentTarget.set(data.appointment);
        if (initial) this.feeInput = ((data.appointment.fee_paise || 0) / 100).toFixed(2);
      }
    } catch (e) {
      if (epoch === this.sessionEpoch && request === this.paymentRequestId)
        this.paymentError.set(this.errorText(e));
    } finally {
      if (epoch === this.sessionEpoch && request === this.paymentRequestId)
        this.paymentLoading.set(false);
    }
  }
  resetPaymentConfirmation() {
    this.paymentConfirmed = false;
    this.paymentError.set('');
  }
  async saveAppointmentFee() {
    const a = this.paymentTarget(),
      amount = this.paise(this.feeInput);
    if (
      !a ||
      this.busy() ||
      amount === null ||
      this.paymentDetails()?.entries.length ||
      this.paymentDetails()?.adjustments?.length ||
      a.fee_basis !== 'legacy_estimate'
    )
      return;
    this.busy.set(true);
    this.paymentError.set('');
    try {
      const d = await firstValueFrom(
        this.api.patch<PaymentDetails>('/admin/appointments/' + a.id + '/fee', {
          fee_paise: amount,
        }),
      );
      this.paymentDetails.set(d);
      this.paymentTarget.set(d.appointment);
      await this.refresh(true);
    } catch (e) {
      this.paymentError.set(this.errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
  async recordPayment() {
    const a = this.paymentTarget();
    if (!a || this.busy() || !this.paymentFormValid) return;
    const body = {
      kind: this.paymentKind,
      amount_paise: this.paise(this.paymentAmount)!,
      method:
        this.paymentKind === 'refund'
          ? this.refundOptions.find((e) => e.id === Number(this.refundPaymentId))?.method || ''
          : this.paymentMethod,
      reference: this.paymentReference.trim(),
      notes: this.paymentNotes.trim(),
      ...(this.paymentKind === 'refund'
        ? { original_payment_id: Number(this.refundPaymentId), refund_type: this.refundType }
        : {}),
    };
    const signature = JSON.stringify(body);
    if (this.paymentIntent?.signature !== signature)
      this.paymentIntent = { signature, key: crypto.randomUUID() };
    this.busy.set(true);
    this.paymentError.set('');
    try {
      const d = await firstValueFrom(
        this.api.post<PaymentDetails>('/admin/appointments/' + a.id + '/payments', {
          ...body,
          idempotency_key: this.paymentIntent!.key,
        }),
      );
      this.paymentDetails.set(d);
      this.paymentTarget.set(d.appointment);
      this.paymentAmount = '';
      this.paymentReference = '';
      this.paymentNotes = '';
      this.paymentConfirmed = false;
      this.paymentIntent = null;
      this.success.set('Ledger entry saved. No money was moved by CareFlow.');
      await this.refresh(true);
    } catch (e) {
      this.paymentError.set(this.errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
  refundType: 'correction' | 'goodwill' = 'correction';
  waiverAmount = '';
  waiverReason = '';
  private waiverIntent: { signature: string; key: string } | null = null;
  effectiveCharge(a: Appointment) {
    return (
      a.effective_charge_paise ??
      (['cancelled', 'no_show'].includes(a.status)
        ? 0
        : Math.max(0, (a.fee_paise || 0) - (a.waived_paise || 0)))
    );
  }
  outstanding(a: Appointment) {
    return a.outstanding_paise ?? Math.max(0, this.effectiveCharge(a) - (a.paid_paise || 0));
  }
  refundable(a: Appointment) {
    return a.refundable_paise ?? Math.max(0, (a.paid_paise || 0) - this.effectiveCharge(a));
  }
  get waiverValid() {
    const a = this.paymentDetails()?.appointment,
      amount = this.paise(this.waiverAmount);
    return (
      !!a &&
      amount !== null &&
      amount > 0 &&
      amount <= this.effectiveCharge(a) &&
      this.validActionReason(this.waiverReason)
    );
  }
  async recordWaiver() {
    const a = this.paymentTarget();
    if (!a || this.busy() || !this.waiverValid) return;
    const body = { amount_paise: this.paise(this.waiverAmount)!, reason: this.waiverReason.trim() };
    const signature = JSON.stringify(body);
    if (this.waiverIntent?.signature !== signature)
      this.waiverIntent = { signature, key: crypto.randomUUID() };
    this.busy.set(true);
    this.paymentError.set('');
    try {
      await firstValueFrom(
        this.api.post('/admin/appointments/' + a.id + '/waivers', {
          ...body,
          idempotency_key: this.waiverIntent!.key,
        }),
      );
      this.waiverAmount = '';
      this.waiverReason = '';
      this.waiverIntent = null;
      await this.loadPaymentDetails(a.id);
      this.success.set(
        'Charge reduction recorded. No money was moved; any refundable excess must be returned manually.',
      );
      await this.refresh(true);
    } catch (e) {
      this.paymentError.set(this.errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
  visitTarget = signal<Appointment | null>(null);
  visitAction: 'reschedule' | 'no_show' | 'history' = 'history';
  visitReason = '';
  visitError = signal('');
  visitHistory = signal<VisitHistory[]>([]);
  historyLoading = signal(false);
  private visitRequestId = 0;
  clinicTime(value: string) {
    return clinicTimestamp(value);
  }
  validActionReason(value: string) {
    return value.trim().length >= 5 && value.trim().length <= 500;
  }
  get hasReplacementSlots() {
    return this.slots().some(
      (slot) => this.slotAvailable(slot) && slot.id !== this.visitTarget()?.slot_id,
    );
  }
  canReschedule(a: Appointment) {
    return a.status === 'booked' && !a.checked_in_at && isFutureClinicTime(a.start_time);
  }
  canNoShow(a: Appointment) {
    return (
      this.isAdmin &&
      a.status === 'booked' &&
      !a.checked_in_at &&
      clinicMillis(a.end_time) <= this.today.getTime()
    );
  }
  async openVisitAction(a: Appointment, action: 'reschedule' | 'no_show' | 'history') {
    if (this.busy() || this.modalOpen) return;
    if (
      (action === 'reschedule' && !this.canReschedule(a)) ||
      (action === 'no_show' && !this.canNoShow(a))
    )
      return;
    this.visitTarget.set(a);
    this.visitAction = action;
    this.visitReason = '';
    this.visitError.set('');
    this.visitHistory.set([]);
    this.bookingDate = this.minDate;
    this.selectedSlot.set(null);
    this.slots.set([]);
    this.focusDialog();
    const request = ++this.visitRequestId,
      epoch = this.sessionEpoch;
    this.historyLoading.set(true);
    if (action === 'reschedule') void this.loadSlots();
    try {
      const data = await firstValueFrom(
        this.api.get<{ history: VisitHistory[] }>('/appointments/' + a.id + '/history'),
      );
      if (request === this.visitRequestId && epoch === this.sessionEpoch)
        this.visitHistory.set(data.history);
    } catch (e) {
      if (request === this.visitRequestId && epoch === this.sessionEpoch)
        this.visitError.set(this.errorText(e));
    } finally {
      if (request === this.visitRequestId) this.historyLoading.set(false);
    }
  }
  closeVisitAction() {
    if (this.busy()) return;
    this.visitTarget.set(null);
    this.visitRequestId++;
    this.slotRequestId++;
    this.slotsLoading.set(false);
    this.historyLoading.set(false);
    this.restoreFocus();
    this.tryShowCancellationNotice();
  }
  async confirmVisitAction() {
    const a = this.visitTarget(),
      slot = this.selectedSlot(),
      action = this.visitAction;
    if (!a || this.busy() || action === 'history' || !this.validActionReason(this.visitReason))
      return;
    if (action === 'reschedule' && (!slot || !this.slotAvailable(slot) || !this.canReschedule(a)))
      return;
    if (action === 'no_show' && !this.canNoShow(a)) return;
    this.busy.set(true);
    this.visitError.set('');
    try {
      const path =
        action === 'reschedule'
          ? '/appointments/' + a.id + '/reschedule'
          : '/admin/appointments/' + a.id + '/no-show';
      const body =
        action === 'reschedule'
          ? { slotId: slot!.id, reason: this.visitReason.trim(), expected_slot_id: a.slot_id }
          : { reason: this.visitReason.trim() };
      await firstValueFrom(this.api.patch(path, body));
      this.visitTarget.set(null);
      this.visitRequestId++;
      this.slotRequestId++;
      this.restoreFocus();
      this.success.set(
        action === 'reschedule'
          ? 'Visit rescheduled. Original charge and ledger references are preserved; no money was moved.'
          : 'No-show recorded and charge waived. Any net money received requires a manual refund; no money was moved.',
      );
      await this.refresh();
    } catch (e) {
      this.visitError.set(this.errorText(e));
    } finally {
      this.busy.set(false);
      this.tryShowCancellationNotice();
    }
  }
  async setArrived(a: Appointment, event: Event) {
    const input = event.target as HTMLInputElement,
      arrived = input.checked;
    input.checked = !!a.checked_in_at;
    if (this.busy() || !this.isAdmin || a.status !== 'booked') return;
    if (
      !arrived &&
      !window.confirm(
        'Clear this arrival check-in? Use Complete visit instead if the patient has finished.',
      )
    )
      return;
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(this.api.patch('/admin/appointments/' + a.id + '/arrival', { arrived }));
      this.success.set(
        arrived
          ? 'Patient marked as arrived. When the visit finishes, choose Complete visit.'
          : 'Arrival check-in cleared.',
      );
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }
  async setStatus(a: Appointment, status: 'completed' | 'cancelled') {
    if (status === 'cancelled') {
      this.openAdminCancellation(a);
      return;
    }
    if (
      this.busy() ||
      !this.canComplete(a) ||
      !window.confirm('Has the patient finished the visit and left? Mark this visit as completed?')
    )
      return;
    this.busy.set(true);
    this.clearMessages();
    try {
      await firstValueFrom(
        this.api.patch('/admin/appointments/' + a.id + '/status', { status: 'completed' }),
      );
      this.success.set('Visit completed. Arrival and completion times are saved.');
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
      this.tryShowCancellationNotice();
    }
  }
}
